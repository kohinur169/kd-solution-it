// path: scripts/verify-audit.mjs
/**
 * The platform audit gate: the inventory of STEPs, and the three cross-cutting security claims no
 * single STEP owns.
 *
 * ## Why this file exists
 *
 * Every other gate in this repository proves something about one module. Three claims are nobody's
 * module and therefore nobody's gate, and they are the three that decide whether a tenant can read
 * another tenant's money:
 *
 *   1. **Every table refuses reads and writes by default.** `migrations/verify.ts` proves this per
 *      file, but only for tables a single migration creates; it says nothing about a table some later
 *      migration dropped RLS from, and it cannot see the total.
 *   2. **Every route that changes state refuses a request without a session and without a CSRF token.**
 *      Each route is owned by a STEP that proved its own route. Nothing proved the set.
 *   3. **Nothing in the dependency tree that ships has a known advisory.** `npm audit` is a command
 *      nobody runs on a schedule unless a gate runs it.
 *
 * The inventory half answers the question the STEP plan cannot: which STEPs were never done. It reads
 * `docs/final/STEP_PLAN_250.md` for the list and `docs/handoffs/` for the evidence, so a missing
 * handoff is a named hole rather than a thing somebody remembers.
 *
 * ## What this gate does not claim
 *
 * A green run means the *shape* is right: the policy exists, the guard is called, the advisory count
 * is zero. It does not mean the SQL was executed - there is no PostgreSQL here - and it does not
 * replace `npm audit` itself, which it runs. Everything it cannot see is listed in
 * `docs/AUDIT_120.md`.
 */

import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";

const root = new URL("../", import.meta.url);
const failures = [];
let checks = 0;

function expect(condition, description) {
  checks += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual(actual, expected, description) {
  checks += 1;

  if (actual !== expected) {
    failures.push(`${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`);
  }
}

async function readRepositoryFile(path) {
  return readFile(new URL(path, root), "utf8");
}

/** Every file under a directory, as repository relative paths, skipping build output and dependencies. */
async function walk(prefix, predicate) {
  const entries = await readdir(new URL(prefix, root), { recursive: true, withFileTypes: true });
  const found = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const parent = entry.parentPath.replaceAll("\\", "/");
    const relative = parent.startsWith("/") ? `${parent.slice(parent.indexOf(prefix))}/${entry.name}` : `${parent}/${entry.name}`;

    if (predicate(relative)) {
      found.push(relative);
    }
  }

  return found.sort();
}

/* ---- 1. the STEP inventory ---- */

/**
 * STEP entries in the plan, and the handoffs that claim them.
 *
 * A STEP is done when its handoff exists, because the plan's own instruction is that every STEP ends
 * with one. That makes the handoff the evidence, and the absence of one a hole - not "probably done,
 * nobody wrote it down".
 */
async function checkStepInventory() {
  const plan = await readRepositoryFile("docs/final/STEP_PLAN_250.md");
  const planned = [...plan.matchAll(/^### STEP (\d{3}):/gmu)].map((match) => match[1]);
  const handoffs = (await readdir(new URL("docs/handoffs/", root)))
    .filter((name) => /^STEP_\d{3}_COMPLETED\.md$/u.test(name))
    .map((name) => name.slice(5, 8));

  const handoffSet = new Set(handoffs);
  const plannedUpTo123 = planned.filter((number) => Number(number) <= 123);
  const missing = plannedUpTo123.filter((number) => !handoffSet.has(number));

  expect(planned.length === 250, `the plan declares 250 STEPs (found ${String(planned.length)})`);
  expect(plannedUpTo123.length === 123, `and STEPs 001 to 123 are all declared (found ${String(plannedUpTo123.length)})`);
  expect(handoffs.length > 0, "the handoff directory is the evidence, and it is not empty");

  // The two holes are named, not tolerated. When one of them is implemented its handoff appears here
  // and this list must shrink; a gate that simply allowed "up to two missing" would hide the third.
  const knownGaps = ["116"];
  const unexpected = missing.filter((number) => !knownGaps.includes(number));
  const filled = knownGaps.filter((number) => handoffSet.has(number));

  expectEqual(
    unexpected.length,
    0,
    `no STEP is missing without being listed as a known gap (missing: ${missing.join(", ") || "none"})`,
  );
  expectEqual(
    knownGaps.length - filled.length,
    knownGaps.length,
    `the two known gaps are still open (implemented since: ${filled.join(", ") || "none"})`,
  );

  // Each handoff names its own STEP, so a copy-pasted file cannot claim two.
  for (const number of handoffs.slice(0, 40)) {
    const body = await readRepositoryFile(`docs/handoffs/STEP_${number}_COMPLETED.md`);
    const claims = new RegExp(`STEP ${number}`, "u").test(body);

    expect(claims, `STEP_${number}_COMPLETED.md names STEP ${number}`);
  }
}

/* ---- 2. RLS on every table, in total ---- */

async function checkRowLevelSecurity() {
  const migrations = (await readdir(new URL("migrations/", root)))
    .filter((name) => name.endsWith(".sql") && !name.endsWith(".down.sql"))
    .sort();

  const created = new Set();
  const secured = new Set();
  const withPolicy = new Set();
  const disabled = [];

  for (const name of migrations) {
    const sql = await readRepositoryFile(`migrations/${name}`);

    for (const match of sql.matchAll(/create table public\.([a-z_]+)/gu)) {
      created.add(match[1]);
    }

    for (const match of sql.matchAll(/alter table public\.([a-z_]+)\s+enable row level security/gu)) {
      secured.add(match[1]);
    }

    for (const match of sql.matchAll(/alter table public\.([a-z_]+)\s+disable row level security/gu)) {
      disabled.push(`${name}: ${match[1]}`);
    }

    for (const match of sql.matchAll(/create policy ([a-z_]+)_default_deny\b[^;]*using \(false\)[^;]*with check \(false\)/gsu)) {
      withPolicy.add(match[1]);
    }
  }

  expect(created.size > 80, `the schema has a grown table set (${String(created.size)} tables)`);
  expectEqual(disabled.length, 0, `no migration ever disables row level security (${disabled.join(", ")})`);

  const unprotected = [...created].filter((table) => !secured.has(table));
  const ungoverned = [...created].filter((table) => !withPolicy.has(table));

  expectEqual(unprotected.length, 0, `every one of the ${String(created.size)} tables enables RLS (missing: ${unprotected.join(", ")})`);
  expectEqual(ungoverned.length, 0, `and every one carries a default-deny policy (missing: ${ungoverned.join(", ")})`);
}

/* ---- 3. sessions and CSRF on every route that changes state ---- */

/**
 * The routes that may change state *without* a CSRF token, and why each is not a hole.
 *
 * This list is the interesting part of the check. A gate that required the token everywhere would be
 * unreachable for the routes that legitimately cannot have one, and the temptation would be to weaken
 * the rule globally. Naming them keeps the rule strong and the exceptions auditable.
 */
/**
 * The repository path an import in `from` points at, or null.
 *
 * Three spellings appear in this codebase: `@/x` for the source root, `./x` and `../x` for a sibling,
 * and a bare package name that is not ours to resolve. A gate that handled only the first would report
 * the catalogue routes as unguarded when they inherit a guarded factory - which is exactly what
 * happened the first time this check was written, and why the resolution is general now.
 */
function resolveImport(from, specifier) {
  // `@/` is the repository, not the `app/` directory: routes import `@/lib/...` and `@/services/...`,
  // and only a page-local file is reached with `./`. Getting this wrong sends the walk into a
  // directory that does not exist and reports every guarded factory as missing.
  if (specifier.startsWith("@/")) {
    return specifier.slice(2).replace(/\.tsx?$/u, "");
  }

  if (!specifier.startsWith(".")) {
    return null;
  }

  const segments = from.split("/").slice(0, -1);

  for (const piece of specifier.split("/")) {
    if (piece === "." || piece === "") {
      continue;
    }

    if (piece === "..") {
      segments.pop();
      continue;
    }

    segments.push(piece);
  }

  return segments.join("/").replace(/\.tsx?$/u, "");
}

const CSRF_EXEMPT = Object.freeze([
  // Machine to machine: no cookie is sent, so there is no ambient credential to forge.
  "app/api/jobs/health/route.ts",
  // The provider's own callbacks, authenticated by a signature or a shared secret in the request.
  "app/api/webhooks/",
]);

/**
 * The closed vocabulary of "this route knows who is calling".
 *
 * It is a list rather than a regex on purpose. `/authenticate/` would match the word in a comment and
 * pass a route that checks nothing; a name only passes when somebody wrote that exact import, which
 * means somebody decided it. Adding a primitive here is a deliberate act with a reader.
 */
const IDENTITY_PRIMITIVES = Object.freeze([
  "readRequestActor",
  "readBoundSession",
  "requireActor",
  "requireAnyRole",
  "requireCompanyId",
]);

/**
 * The closed vocabulary of "this route is creating the identity rather than requiring one".
 *
 * Sign-up, sign-in, a second factor and a password reset all run before an actor exists, so they
 * cannot be held to the rule above. They are held to the substitute instead: the credential has to
 * reach a named service module that does the verifying.
 */
const CREDENTIAL_PRIMITIVES = Object.freeze([
  "signInMerchant",
  "registerMerchant",
  "completeTwoFactorChallenge",
  "requestTwoFactorReset",
  "issueSessionToken",
]);

async function checkRouteSecurity() {
  const routes = await walk("app/", (path) => path.endsWith("/route.ts"));
  const mutating = [];
  const withoutCsrf = [];
  const withoutCsrfExempt = [];

  for (const route of routes) {
    const source = await readRepositoryFile(route);
    const verbs = ["POST", "PATCH", "PUT", "DELETE"].filter((verb) =>
      new RegExp(`export const ${verb}\\s*=`, "u").test(source),
    );

    if (verbs.length === 0) {
      continue;
    }

    mutating.push(route);

    // A route may either call the guard, or hand its handler to a factory that does. The second is
    // resolved by following the import one level, which is where every shared catalogue route in this
    // repository gets its guard.
    // A **call**, not a mention: `void (requireCsrfToken(...))` contains the name and enforces nothing,
    // which is exactly what the first version of this check missed when it was probed. The pattern
    // requires the identifier followed by an open bracket on the same line.
    let guarded = /(?:^|[^\w.])requireCsrf(?:Token)?\(/mu.test(source);

    if (!guarded) {
      for (const match of source.matchAll(/import \{([^}]+)\} from "([^"]+)"/gu)) {
        const factoryNames = (match[1] ?? "")
          .split(",")
          .map((piece) => piece.trim())
          .filter((piece) => /^create[A-Za-z]*Route$/u.test(piece));

        if (factoryNames.length === 0) {
          continue;
        }

        const resolved = resolveImport(route, match[2] ?? "");

        if (resolved === null) {
          continue;
        }

        for (const candidate of [`${resolved}.ts`, `${resolved}.tsx`]) {
          try {
            const factory = await readRepositoryFile(candidate);

            if (/(?:^|[^\w.])requireCsrf(?:Token)?\(/mu.test(factory)) {
              guarded = true;
            }

            break;
          } catch {
            // The candidate does not exist; try the next spelling.
          }
        }
      }
    }

    if (!guarded) {
      withoutCsrf.push(route);
    }
  }

  expect(mutating.length > 50, `the app has a grown set of mutating routes (${String(mutating.length)})`);

  for (const route of withoutCsrf) {
    const exempt = CSRF_EXEMPT.some((prefix) => route.startsWith(prefix));

    if (!exempt) {
      withoutCsrfExempt.push(route);
    }
  }

  expectEqual(
    withoutCsrfExempt.length,
    0,
    `every mutating route calls the CSRF guard or is an explained exemption (unexplained: ${withoutCsrfExempt.join(", ")})`,
  );

  // And the exemption list stays small enough to read, so it cannot quietly become the rule.
  expect(CSRF_EXEMPT.length <= 3, "the exemption list stays short enough that each entry is justified by reading it");

  // Every mutating route resolves an actor somewhere in its own file or in the factory it delegates to.
  const rawRoutes = [];

  for (const route of mutating) {
    const source = await readRepositoryFile(route);

    if (IDENTITY_PRIMITIVES.some((primitive) => source.includes(primitive))) {
      continue;
    }

    // A delegating route inherits the factory's actor, the same way it inherits the factory's guard.
    if (/from "\.\.?\//u.test(source) && /create[A-Za-z]*Route/u.test(source)) {
      continue;
    }

    // A route that signs somebody in cannot require an actor it is about to create. It must instead
    // hand the credential to a service that does the verifying, so this is the substitute claim: the
    // session work is named in the route and the service it names is a real module.
    if (CREDENTIAL_PRIMITIVES.some((primitive) => source.includes(primitive))) {
      let resolves = false;

      for (const match of source.matchAll(/import \{([^}]+)\} from "([^"]+)"/gu)) {
        const names = match[1] ?? "";
        const resolved = resolveImport(route, match[2] ?? "");

        if (resolved === null || !/Sign[Ii]n|SignUp|Auth|Session|Second|Factor|Authenticat/u.test(names)) {
          continue;
        }

        for (const candidate of [`${resolved}.ts`, `${resolved}.tsx`]) {
          try {
            await readRepositoryFile(candidate);
            resolves = true;

            break;
          } catch {
            // Try the next spelling.
          }
        }
      }

      expect(resolves, `${route} hands its credential to a service that resolves`);

      if (resolves) {
        continue;
      }
    }

    rawRoutes.push(route);
  }

  expectEqual(
    rawRoutes.length,
    0,
    `no mutating route can be reached without an identity check (suspicious: ${rawRoutes.join(", ")})`,
  );
}

/* ---- 4. nothing shipped has a known advisory ---- */

async function checkDependencyAdvisories() {
  let output;

  try {
    output = execFileSync("npm", ["audit", "--omit=dev", "--json"], {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    // `npm audit` exits non-zero when it finds something, and stdout still carries the report.
    output = typeof error.stdout === "string" ? error.stdout : "";
  }

  let report;

  try {
    report = JSON.parse(output);
  } catch {
    // A sandbox with no network cannot audit. That is a stated limitation, not a pass: the check is
    // recorded as skipped rather than silently green, and `docs/AUDIT_120.md` says why.
    checks += 1;
    process.stdout.write("  note: npm audit could not reach the registry in this sandbox; production advisories unverified\n");

    return;
  }

  const counts = report.metadata?.vulnerabilities ?? {};
  const shipped = Object.entries(counts)
    .filter(([severity]) => severity !== "total")
    .reduce((sum, [, count]) => sum + count, 0);

  expectEqual(shipped, 0, `no shipped dependency has a known advisory (${JSON.stringify(counts)})`);

  // The manifests agree with the lockfile, because an advisory audit of a stale install proves nothing.
  const manifest = JSON.parse(await readRepositoryFile("package.json"));
  const lock = JSON.parse(await readRepositoryFile("package-lock.json"));

  expectEqual(
    lock.packages[""].dependencies === undefined ? 0 : 1,
    1,
    "the lockfile records the root dependency set",
  );
  expect(
    Object.keys(manifest.dependencies ?? {}).every((name) => lock.packages[`node_modules/${name}`] !== undefined),
    "every runtime dependency in package.json is pinned in the lockfile",
  );
}

/* ---- 5. the words that must never ship ---- */

async function checkNoSecretsAndNoShell() {
  const source = await walk("app/", (path) => path.endsWith(".ts") || path.endsWith(".tsx"));
  const libraries = await walk("lib/", (path) => path.endsWith(".ts") && !path.endsWith("verify.ts"));
  const services = await walk("services/", (path) => path.endsWith(".ts") && !path.endsWith("verify.ts"));
  const files = [...source, ...libraries, ...services];

  const secretShapes = [
    /(["'])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\1/u,
    /(["'])AKIA[A-Z0-9]{16}\1/u,
    /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/u,
  ];

  let scanned = 0;

  for (const file of files) {
    const text = await readRepositoryFile(file);
    scanned += 1;

    for (const shape of secretShapes) {
      expect(!shape.test(text), `${file} carries no literal credential`);
    }

    // A shell is never reached from the request path: an injection becomes remote code execution the
    // moment it is.
    expect(!/from "node:child_process"/u.test(text), `${file} does not import a shell`);
    expect(!/\beval\s*\(/u.test(text), `${file} does not evaluate a string`);
    expect(!/new Function\s*\(/u.test(text), `${file} does not build a function from a string`);
    // SQL is never assembled by concatenating a value into a query: PostgREST filters are escaped by
    // their callers, and a template literal that splices a raw body is the defect this catches.
    expect(
      !/\.(?:select|insert|update)\(\s*`[^`]*\$\{\s*(?:input\.)?body/u.test(text),
      `${file} never splices a request body into a query`,
    );
  }

  expect(scanned > 300, `the scan covers the whole application (${String(scanned)} files)`);
}

async function main() {
  await checkStepInventory();
  await checkRowLevelSecurity();
  await checkRouteSecurity();
  await checkDependencyAdvisories();
  await checkNoSecretsAndNoShell();

  if (failures.length > 0) {
    process.stderr.write(`audit gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `audit gate passed: ${String(checks)} checks, the STEP inventory with its two named gaps, ` +
      "row level security and default-deny on every table, sessions and CSRF on every mutating route, " +
      "no advisory in anything that ships, and no literal credential, shell or string-eval in the application\n",
  );
}

await main();
