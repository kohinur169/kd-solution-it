// path: docs/planning/STEP_056_SUBSTEP_BREAKDOWN.md
# STEP 056 - Sub-step breakdown

STEP 056: **Input sanitizer library for text, rich text and URLs**
(`docs/final/STEP_PLAN_250.md` line 740), from `docs/final/FEATURE_LIST.md` line 12
("Sanitization for every input: XSS, SQL injection, CSRF, SSRF, header injection, null byte, path
traversal, Unicode normalization") and `docs/final/MASTER_PROMPT.md` rule 11.

## What already exists, and what is missing

Every STEP so far has been defensive about its own input, and each did it in its own way: zod
schemas with `.trim()` and `.max()`, `login_attempts` with a column check on the user agent, the
disclosure table deciding which codes a stranger may see. What the platform does not have is one
library that answers "what is a safe text, a safe URL and a safe rich text", so the rules are
re-implemented wherever they are needed and the answer to "is this string safe" depends on which
file is asked.

The stack names DOMPurify for browser-side rich text. `package.json` is not a STEP's to edit, so this
STEP builds the server-side rule set with no dependency and records the DOMPurify request for the
browser preview that the CMS STEP will own.

## The decisions this STEP makes

1. **Sanitise by rebuilding, never by removing.** A rich text is tokenised, decoded, filtered through
   an allowlist of tags and attributes and then **re-serialised from the tree**, with the text always
   escaped on the way out. A regular expression that strips `<script>` from the input is the classic
   way to lose this argument - it fails on `<scr<script>ipt>`, on an attribute without quotes and on
   a comment that ends early. Nothing from the input reaches the output verbatim.
2. **Unicode first, because everything after it assumes one string.** Input is NFC-normalised and then
   stripped of null bytes, C0 and C1 controls, line and paragraph separators, zero-width characters,
   bidirectional overrides and tag characters - the direction of rule 12's "Unicode normalization"
   and the class of the Trojan Source attacks. A name with a right-to-left override is not a name;
   it is a string that displays differently from what it is.
3. **A URL is allowed only if it is https, public and unadorned.** `javascript:`, `data:`, `vbscript:`,
   protocol-relative `//evil`, `user:pass@host`, a backslash, a control character, a port nobody
   serves, a loopback address, a private range and a `.internal` name are each refused with a named
   reason. The private-range rule is SSRF's: this platform makes outbound calls to payment and KYC
   providers, and a URL that points at `169.254.169.254` is a request to read the host's credentials.
4. **A path is allowed only if it cannot leave its root.** Relative paths are decoded **once**, then
   refused for `..`, for a backslash, for a null byte and for a scheme, and rebuilt from segments.
5. **A library returns a reason, not a thrown value.** Each function answers a typed decision
   (`{ ok: true, value }` or `{ ok: false, reason }`), because a caller needs the reason to write the
   catalogue detail that a form shows; the three throwing wrappers exist for the routes and services
   that only need `VALIDATION_FAILED`.
6. **The rules are one place and the gate proves them.** `lib/security/verify.ts` carries the attack
   corpus - about a hundred cases, each a string that has broken a sanitiser somewhere - and
   `npm run check:security` runs it. The package request for that script is in the handoff, and three
   integration points are also asserted by the auth gate so the wiring cannot silently disappear.

## Sub-step 1 - Read the contract

`FEATURE_LIST.md` line 12, `MASTER_PROMPT.md` rules 10-11 and the stack line that names DOMPurify,
`lib/README.md`, `lib/errors/README.md` (the module shape and the gate convention), the STEP 055
handoff's "Next", and the three call sites the library will serve: `registration.ts`,
`two-factor-reset.ts` and `account-unlock.ts`.

## Sub-step 2 - Owned paths

New: `lib/security/{README.md,text.ts,host.ts,url.ts,html.ts,verify.ts}`,
`docs/planning/STEP_056_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_056_COMPLETED.md`.

Modified: `lib/auth/registration.ts`, `lib/auth/two-factor-reset.ts`, `lib/auth/account-unlock.ts`
(the three consumers), `lib/auth/verify.ts` (the wiring assertions), `lib/security` and
`config/structure.json` (the new directory in the manifest).

## Sub-step 3 - Database

None. Nothing is stored, nothing is indexed and no counter is written: the library is a pure function
of its input, and a migration for it would be a table nobody reads.

## Sub-step 4 - The library

- `text.ts` - `sanitizeSingleLineText`, `sanitizeMultilineText`, `sanitizeHeaderValue`,
  `sanitizeFileName`, `sanitizeSlug`, `escapeHtml`, `describeTextIssues`.
- `host.ts` - `isPublicAddress` (the IPv4 and IPv6 ranges a request must never reach),
  `isPublicHostname`, `isIpLiteral`.
- `url.ts` - `sanitizeHttpUrl`, `requireHttpUrl`, `sanitizeRelativePath`, `isSafeRedirect`.
- `html.ts` - `sanitizeRichText` (allowlist, re-serialised), `stripMarkup`, `RICH_TEXT_POLICY`.
- `verify.ts` - the attack corpus and the policy assertions.

## Sub-step 5 - Wiring

The three call sites that already take a person's words: the signup name and company name, the reset
request's document reference and note, and the unlock note. Each is sanitised before it is validated
and before it reaches the database, and the auth gate asserts each call.

## Sub-step 6 - UI

Not applicable: the library runs on the server, and its output is a string the existing screens already
render as text. A screen would be a demonstration of the sanitiser rather than a feature of the
platform, and rule 4 has no room for one.

## Sub-step 7 - Security proof

The attack corpus of `lib/security/verify.ts`, the wiring assertions in `lib/auth/verify.ts`, and the
mutation controls recorded in the handoff.

## Sub-step 8 - Gates, commit, push, handoff

`npx tsc --noEmit`, `npm run lint`, `node lib/security/verify.ts`, `node lib/auth/verify.ts`,
`npm run verify`, one commit `STEP 056: Input sanitizer library for text, rich text and URLs`, pushed
to `arena/1dc51ec3-kd-solution-it`, with `docs/handoffs/STEP_056_COMPLETED.md`.
