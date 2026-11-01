// path: docs/planning/STEP_048_SUBSTEP_BREAKDOWN.md
# STEP 048 - Sub-step breakdown

STEP 048: Generic authentication error messages that reveal nothing about accounts.

Source of scope: `docs/final/STEP_PLAN_250.md` line 640, `docs/final/FEATURE_LIST.md`
section 22 line 243 ("Error messages never reveal whether an account exists"), section 22 lines
237-243 (lock answers arrive only after a correct password), `docs/final/MASTER_PROMPT.md`
rules 10, 11, 16 and `docs/handoffs/STEP_047_COMPLETED.md` (the seam that named this STEP).

## Owned paths

| Path | Why this STEP owns it |
| --- | --- |
| `lib/auth/disclosure.ts` (new) | The one contract: which surface may answer with which code, the constant acceptance answer and the rule that a detail may not describe an account. |
| `lib/auth/client.ts` | The signup answer schema: the provider's obfuscated duplicate has to be visible to the caller before the platform writes anything. |
| `lib/auth/registration.ts` | The duplicate-address path, its compensation guard and the indistinguishability of the result. |
| `app/api/auth/signup/route.ts` | One acceptance answer for every address. |
| `lib/auth/verify.ts` | New `checkDisclosure()` gate, added to the run list. |
| `lib/auth/README.md` | Rules 59-62. |
| `docs/planning/STEP_048_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_048_COMPLETED.md` | This STEP's planning and handoff documents. |

No migration: this STEP changes answers, not tables. Nothing in `package.json`.

## Sub-steps, in order

1. **Recon.** Read the plan section, FEATURE_LIST 22, the 047 handoff and every auth route,
   then list the codes each anonymous surface can already answer with. Done before this
   document: signin and 2FA reset already answer one sentence, signup does not.
2. **The defect this STEP removes.** Audited `signUpWithPassword`: the provider answers an
   existing address with an obfuscated user whose `identities` list is empty and whose id is
   the *existing* account's id. `signUpWithPassword` dropped that field, so registration
   treated the duplicate as a new account: it created a company, hit the `users` unique index,
   then compensated - soft closing and provider-deleting the account of the person who was
   already registered, and answering `409 CONFLICT`. Three failures in one: an existence
   answer, a destroyed account and an orphan company.
3. **`lib/auth/disclosure.ts`.** The catalogue of anonymous surfaces with the codes each may
   answer, the constant signup acceptance body, the deny-list of detail rules that describe an
   account and the one rejection helper. Pure data and pure functions so the gate can read it.
4. **`lib/auth/client.ts`.** Parse `identities` on the signup user and expose
   `existingAddress` on `SignUpResult`: true only when the provider listed no identity and
   returned no session.
5. **`lib/auth/registration.ts`.** Three backstops, in cost order: the provider's
   `existingAddress`, the platform's own email lookup after the provider call, and a conflict
   on the `users` insert while writing. All three return `{ status: "indistinguishable" }`
   with nothing written. `compensate()` learns `userRowWritten` and refuses to touch a
   provider user the platform never recorded, so no future path can close another party's
   account.
6. **`app/api/auth/signup/route.ts`.** `201` with `{"status":"verification_required"}` for
   every accepted address, `status` in the log instead of the address.
7. **`checkDisclosure()`.** Catalogue covers every route file under `app/api/auth/`; every
   catalogued code exists; no anonymous surface lists `CONFLICT`, `PERMISSION_DENIED`,
   `RESOURCE_NOT_FOUND` or `UNSUPPORTED_MEDIA_TYPE`; detail rules on anonymous answers are
   never account describing; duplicate signup writes nothing and answers the same body as a
   fresh one; the platform-conflict path soft closes only what it wrote; the provider user is
   left alone when ownership is unproven; signin and 2FA reset answer identically for a known
   and an unknown address; `ACCOUNT_LOCKED` is unreachable before the password.
8. **Gates.** `tsc --noEmit`, `eslint .`, `node lib/auth/verify.ts`, `npm run verify`,
   negative control, one commit, push, handoff, report.
