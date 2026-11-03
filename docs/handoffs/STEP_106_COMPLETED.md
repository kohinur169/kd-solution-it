// path: docs/handoffs/STEP_106_COMPLETED.md
# STEP 106 - Client create and edit forms with Zod validation: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 106 code are in one commit, the
one whose message is "STEP 106: Client create and edit forms with Zod validation" (`git log -1` on
the branch shows its hash). Previous handoff: `docs/handoffs/STEP_105_COMPLETED.md`. This is the
first STEP of the Clients, Products, Invoices and Estimates block (106-126).

## STEP

- **Number and title:** STEP 106 - Client create and edit forms with Zod validation
  (`docs/final/STEP_PLAN_250.md`, line 1346).
- **Category:** Clients, Products, Invoices and Estimates, STEPs 106-126. First STEP of the block.
- **Owned paths (File Ownership Rules):** "Business STEPs 106-126 own `services/clients/`,
  `services/products/`, `services/invoices/` and invoice components" (line 53), plus the matching
  screens under `app/(dashboard)/` and routes under `app/api/`. This STEP added
  `services/clients/{client-fields,clients,verify}.ts`, `app/(dashboard)/clients/{page.tsx,
  new/page.tsx, [id]/page.tsx, client-form.tsx}`, `app/api/clients/{route.ts, [id]/route.ts}`, and
  the shared-file extensions of the STEP 099 precedent: `lib/i18n/strings/en.ts` (new `clients`
  section), `lib/security/csrf.ts` (the two new protected paths), `lib/auth/verify.ts` (the
  keeper/mutation counts), `app/(dashboard)/README.md`, plus this handoff.
- **Feature list:** section 15 (`docs/final/FEATURE_LIST.md` lines 163-165: "Client create, edit,
  delete and paginated list", the CSV import belongs to later STEPs) and line 11 ("Zod validation on
  client and server for every form and API").
- **Depends on:** STEP 020's `migrations/0019_clients.sql` - the `public.clients` table with its
  column checks, the partial unique `clients_email_key (company_id, lower(email))`,
  `clients_page_idx`, soft delete and default-deny RLS is the store, so **no migration in this
  STEP**; the STEP 080-083 form/service/route pattern (`services/kyc/business-profile.ts`,
  `app/api/onboarding/business-profile/route.ts`, `app/(dashboard)/onboarding/business/*`).

## What was built

- `services/clients/client-fields.ts` - the one vocabulary: `CLIENT_FIELDS` (the 12 writable
  columns), `CLIENT_ADDRESS_FIELDS` + `CLIENT_ADDRESS_REQUIRED_TRIGGERS` (any address field other
  than line1 set requires line1, mirroring the `0019` `address_complete` check),
  `CLIENT_FIELD_LIMITS` (name 1-120, company_name 1-160, email 3-254 + pattern, phone pattern/32,
  address lines 1-160, city/region 1-80, postal pattern/16, country `^[A-Z]{2}$`, tax_id 1-32,
  notes 1-2000) and the email/phone/postal/country patterns.
- `services/clients/clients.ts` - the service. Zod schemas `clientCreateSchema` /
  `clientUpdateSchema` (partial) / `clientRowSchema`; every refusal is `VALIDATION_FAILED` with
  one `{field, rule}` detail per broken field (rule vocabulary: `required`, `too_short`,
  `too_long`, `invalid_format`, `unknown_field`, `address_requires_line1`); the sanitizers of
  `lib/security/text.ts` strip control characters and collapse whitespace but never truncate to the
  field ceiling, so an over-ceiling value answers `too_long` instead of being silently shortened.
  `createClient` / `getClient` / `updateClient` take the actor, resolve the company from the
  session (`requireAnyRole` + `requireCompanyId`, owner role only), scope every query
  `company_id=eq.<company>` with `deleted_at=is.null` on reads, insert with `return=representation`,
  map a lost unique race on `clients_email_key` to `CONFLICT` `{field:"email", rule:"already_used"}`,
  and re-check the merged row's address rule on update before a conditional version-bumped update
  with a re-read. Audit actions `client.created` / `client.updated` carry the field-name list only,
  never values. Responses stay `no-store` at the route.
- `app/api/clients/route.ts` - `POST` create: `requireCsrfToken` exactly once, before the 16 KiB
  body read, then `readRequestActor`, then the service, 201 with the snapshot.
- `app/api/clients/[id]/route.ts` - `GET` one client (404 for foreign/deleted/unknown) and `POST`
  update, same CSRF-first order.
- `lib/security/csrf.ts` - `/api/clients` and `/api/clients/[id]` added to `CSRF_PROTECTED_PATHS`.
- `lib/i18n/strings/en.ts` - the `clients` section (54 messages: screen copy, the 12 label+hint
  pairs, save/saved lines, and the rule sentences the form shows per refused field).
- `app/(dashboard)/clients/` - the hub (`page.tsx`, links to new and to each edit), `new/page.tsx`
  and `[id]/page.tsx` (signed-out / forbidden / unavailable / not-found / ready states, all through
  the shared `readOwnerActor` reader and `<SessionKeeper />`, `force-dynamic`), and `client-form.tsx`:
  one form for create and edit, posts all 12 fields with the CSRF headers, marks every refused
  detail on its field at once, and on create navigates to `/clients/<id>`.
- `services/clients/verify.ts` - the gate, **175 checks**: the full validation matrix over an
  in-memory PostgREST of the `0019` table, the address rule on create and on the merged edit, the
  per-company email conflict (another merchant may reuse the address), tenant scoping and 404s for
  foreign/deleted rows, owner-only roles, audit field-name-only payloads, plus source checks
  (POST-only routes, CSRF once before `request.text()`, protected list, catalog keys used by the
  form, field ceilings mirrored in `0019`).
- `lib/auth/verify.ts` - keeper count 18 -> 21, browser mutation files 31 -> 32, call sites
  35 -> 36, with the comment naming the three client screens.
- `app/(dashboard)/README.md` - the `clients/` bullet.

## Verification

- `node services/clients/verify.ts` -> "clients gate passed: 175 checks, 12 fields, table
  \"clients\"", exit 0.
- `npm run -s typecheck` exit 0; `npm run -s lint` exit 0; `npm run -s verify` exit 0 (structure
  344 source files, i18n 1662 messages / 185 placeholders, migrations 3261/111/85 unchanged, auth
  gate with the new counts, production build green with `/clients`, `/clients/new`, `/clients/[id]`,
  `/api/clients`, `/api/clients/[id]` all dynamic).
- Smoke on PORT=3107 with `.env.local` from `.env.example`: `/signin`, `/clients`, `/clients/new`
  and `/clients/<id>` all 200 signed out; `POST /api/clients` without a token 422
  `csrf_token_invalid` (token checked before the body); `GET /api/clients/<id>` without a session
  401; server killed, `.env.local` removed.
- ASCII and forbidden-marker scans clean on every touched file.

## What is next

STEP 107 adds the paginated client list with search on the same service (the `0019`
`clients_page_idx` index is already in place); the CSV import of section 15 comes later in the block.
