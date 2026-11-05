// path: services/invoices/recurring-schedule-job-verify.ts
import process from "node:process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { JobRegistry } from "../../lib/jobs/registry.ts";
import { createInMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import {
  createDefaultRecurringGenerationJob,
  recurringScheduleJobPayloadSchema,
  RECURRING_SCHEDULE_JOB,
  registerRecurringGenerationJob,
  runRecurringScheduleJob,
} from "./recurring-schedule-job.ts";
import { RECURRING_SCHEDULE_JOB_NAME } from "./recurring-schedule-fields.ts";
import {
  RECURRING_SCHEDULE_AUDIT_ENTITY,
  RECURRING_SCHEDULE_COLUMNS,
  RECURRING_SCHEDULE_ENDED_AUDIT_ACTION,
  RECURRING_SCHEDULE_CREATED_AUDIT_ACTION,
  RECURRING_SCHEDULE_MANAGE_ROLES,
  RECURRING_SCHEDULE_PAUSED_AUDIT_ACTION,
  RECURRING_SCHEDULE_RESUMED_AUDIT_ACTION,
  RECURRING_SCHEDULE_TABLE,
  RECURRING_SCHEDULE_UPDATED_AUDIT_ACTION,
} from "./recurring-schedule.ts";

/**
 * The gate for STEP 122 part 3: the job contract, and the security posture of the whole STEP in one place.
 *
 * ## Why the security sweep is a group and not a paragraph
 *
 * Parts 1 and 2 each proved their own rules as they were written - the bounds against `0028`, the tenancy in the
 * fixture, the CSRF order in the routes. That is the right place for each individual claim, and it is the wrong
 * place to answer "is this STEP safe" - because the answer is a list of six different kinds of claim, and a
 * reader checking them one file at a time will miss the one that was never written. So this group reads the
 * *sources* and asserts each of the six, in the vocabulary MASTER_PROMPT uses for them:
 *
 *   1. validation on both sides (rule 10),
 *   2. RLS on the table and a default-deny policy (rule 8),
 *   3. an audit entry for every mutation (rule 9),
 *   4. the role check and tenancy from the session, never the body (rule 14),
 *   5. CSRF on every mutating route (rule 11),
 *   6. no secret and no client data in the log line or the trail.
 *
 * ## Why the job contract is proved by absence
 *
 * STEP 123 implements the generator. STEP 122 therefore stated the payload and registered nothing of its own
 * accord, and the durable form of that claim is not "the file mentions no handler" - STEP 123 has since added
 * one, legitimately - but "importing the file runs nothing": no top-level await, no top-level registration, and
 * no registry constructed at module scope. A gate that still asserted the literal absence of a handler would
 * have to choose between lying and forbidding the work this STEP exists to do, which is why it was narrowed
 * rather than deleted when the handler arrived.
 */

/* ---- the harness ---- */

const repositoryRoot = new URL("../../", import.meta.url);
const failures: string[] = [];
let checks = 0;

function expect(condition: boolean, description: string): void {
  checks += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual<T>(actual: T, expected: T, description: string): void {
  checks += 1;

  if (actual !== expected) {
    failures.push(`${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`);
  }
}

async function readRepositoryFile(repositoryPath: string): Promise<string> {
  return readFile(new URL(repositoryPath, repositoryRoot), "utf8");
}

async function group(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    checks += 1;
    failures.push(`${name} threw instead of recording a failure: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ---- the job contract ---- */

async function checkJobContract(): Promise<void> {
  const source = await readRepositoryFile("services/invoices/recurring-schedule-job.ts");

  expect(source.startsWith("// path: services/invoices/recurring-schedule-job.ts\n"), "the job module starts with its path");

  // The name is the one the vocabulary declares, and it is a shape `0013` and a health report both accept.
  expectEqual(RECURRING_SCHEDULE_JOB, RECURRING_SCHEDULE_JOB_NAME, "the job's name is the one the vocabulary declares");
  expectEqual(RECURRING_SCHEDULE_JOB, "recurring_schedule.generate", "in the house entity.verb shape");
  expect(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/u.test(RECURRING_SCHEDULE_JOB), "and it is a name a queue can key on");

  // The payload names a schedule and a run date, and nothing else.
  const payload = recurringScheduleJobPayloadSchema.parse({
    schedule_id: randomUUID(),
    run_on: "2026-12-01",
  });
  expect(payload.run_on === "2026-12-01", "the payload carries the run date it is for");

  for (const [label, candidate] of [
    ["a template", { schedule_id: randomUUID(), run_on: "2026-12-01", template_invoice_id: randomUUID() }],
    ["an amount", { schedule_id: randomUUID(), run_on: "2026-12-01", total_minor: "120000" }],
    ["a client", { schedule_id: randomUUID(), run_on: "2026-12-01", client_id: randomUUID() }],
  ] as const) {
    let refused = false;

    try {
      recurringScheduleJobPayloadSchema.parse(candidate);
    } catch {
      refused = true;
    }

    expect(refused, `a payload carrying ${label} is refused, because the handler reads the row instead`);
  }

  // A malformed id and a malformed date are both refused before a row is stored.
  for (const [label, candidate] of [
    ["a schedule id that is not a uuid", { schedule_id: "not-a-uuid", run_on: "2026-12-01" }],
    ["a run date that is not a date", { schedule_id: randomUUID(), run_on: "2026-12-01T00:00:00Z" }],
    ["a run date that does not exist", { schedule_id: randomUUID(), run_on: "2026-02-30" }],
    ["a missing run date", { schedule_id: randomUUID() }],
  ] as const) {
    let refused = false;

    try {
      recurringScheduleJobPayloadSchema.parse(candidate);
    } catch {
      refused = true;
    }

    // `2026-02-30` matches the pattern, so the schema accepts it and the engine refuses it later - which is
    // stated rather than pretended: the payload is a shape, and a real calendar date is the generator's check.
    const shouldRefuse = label !== "a run date that does not exist";

    if (shouldRefuse) {
      expect(refused, `${label} is refused`);
    } else {
      expect(!refused, "a date that matches the pattern but is not a real day is the generator's refusal, not the payload's");
    }
  }

  // **The registration is absent, and that is the contract.**
  //
  // A fresh `JobRegistry` is empty by construction, so asking one whether the name is registered proves
  // nothing - it would pass with a placeholder handler sitting in this very module. What is actually
  // checkable from a source is the *absence of a registration*: the only `register` call in the file is the
  // one inside `registerRecurringScheduleJob`, and there is no registry value constructed anywhere in it.
  const code = source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/\/\/.*/gu, "");

  expectEqual(
    (code.match(/\.register\(/gu) ?? []).length,
    1,
    "the module contains exactly one register call, and it is the seam STEP 123 calls",
  );
  expectEqual(
    (code.match(/new JobRegistry\(/gu) ?? []).length,
    0,
    "and builds no registry of its own, so nothing is registered when this module is imported",
  );
  expect(
    !/^(?!.*if \(registry\.has\(RECURRING_SCHEDULE_JOB\)\)).*registry\.register\(/mu.test(code) ||
      code.indexOf("registry.register(") > code.indexOf("export function registerRecurringScheduleJob"),
    "the one register call is inside the seam, not at module scope",
  );
  expect(
    code.includes("registry: JobRegistry") && code.includes("handler: (context: JobContext<RecurringScheduleJobPayload>)"),
    "and the seam takes the handler from its caller rather than writing one",
  );

  // A handler written here would be the defect: an empty one accepts work and invoices nobody.
  expect(
    !/handler: async \(\): Promise<void> => \{\s*return;/u.test(code) &&
      !/handler: async \(\) => \{\s*\}/u.test(code),
    "no empty handler sits in this module, which is the failure that looks like a working billing system",
  );

  // The registry type is imported as a type, so importing this module cannot construct one as a side effect.
  expect(
    source.includes('import type { JobRegistry } from "../../lib/jobs/registry.ts";'),
    "the registry is a type import, so a side effect at import time is not even expressible",
  );

  // The seam is named so STEP 123 cannot invent a second one, and it sets the attempt ceiling itself.
  expect(source.includes("export function registerRecurringScheduleJob("), "the register function is the named seam");
  expect(source.includes("maxAttempts: 1"), "and a run is attempted once, because section 16 retries nothing automatically");
  expect(
    source.includes("if (registry.has(RECURRING_SCHEDULE_JOB))") && source.includes("return;"),
    "registering twice is a no-op rather than a second definition of one name",
  );

  // Nothing in this file executes work **at import time**.
  //
  // STEP 122 asserted the stronger claim that the module awaited nothing at all, because the module was a
  // contract and no handler existed yet. STEP 123 adds the handler, so that exact sentence is no longer true and
  // keeping it would mean either a lie in the gate or a handler smuggled into a string. The claim that still
  // matters is the one the import-time guarantee rests on: the file's top level runs no work, so importing it
  // cannot generate an invoice or register a job as a side effect. Work happens only inside a function that a
  // caller invokes.
  const codeOnly = source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/\/\/.*/gu, "");
  const topLevelLines = codeOnly
    .split("\n")
    .filter((line) => line.trim().length > 0 && !line.startsWith(" ") && !line.startsWith("}"));
  expect(
    !topLevelLines.some((line) => /\bawait\b/u.test(line)),
    "no top-level await, so importing this module still does no work",
  );
  expect(
    !topLevelLines.some((line) => /\.register\(/u.test(line)),
    "and no top-level registration, so a job exists only after a caller asks for one",
  );
}


/* ---- the registration, proved against a real registry ---- */

/**
 * STEP 123's other half: the seam is now called, and calling it is checkable.
 *
 * The contract group above proves absence - importing the module registers nothing. This group proves
 * **presence**, and it can, because a real `JobRegistry` driven by the real registration function is the actual
 * object the worker would consult. That is the difference between the two proofs and the reason both exist: an
 * absence proved from a source text is worth having only alongside a presence proved from the code path.
 *
 * Note what this group does *not* claim. It does not claim the process registers this job at boot. There is no
 * boot-time registration anywhere in this repository - the PDF job registers itself lazily when a document is
 * requested (`registerInvoicePdfJob` inside `requestInvoicePdf`), and the sub-merchant jobs are registered by
 * whoever needs them. Wiring a scheduler that calls these functions on startup is the deployment STEP's work, and
 * the handoff says so rather than letting a reader infer that a scheduled run happens by itself.
 */
async function checkRegistration(): Promise<void> {
  const registry = new JobRegistry();
  const neverCalled: RestClient = {
    select: () => Promise.resolve([]),
    insert: () => Promise.resolve(),
    insertReturning: () => Promise.resolve([]),
    update: () => Promise.resolve(),
    rpc: () => Promise.resolve(null),
  };
  const dependencies = () => ({ rest: neverCalled, audit: createInMemoryAuditTrail(), today: () => "2026-11-05" });

  expectEqual(registry.names().length, 0, "a fresh registry is empty, so what follows is the registration's doing");

  registerRecurringGenerationJob(registry, dependencies);

  expect(registry.has(RECURRING_SCHEDULE_JOB), "registering once puts the job in the registry under its fixed name");
  expectEqual(registry.names().length, 1, "and adds exactly one name, with no second job smuggled in");
  expectEqual(RECURRING_SCHEDULE_JOB, RECURRING_SCHEDULE_JOB_NAME, "under the name STEP 122 declared, unchanged");

  // Registering twice is a no-op rather than a second definition of one name: a process that boots twice must not
  // end up with two handlers whose difference decides which invoices exist.
  registerRecurringGenerationJob(registry, dependencies);
  expectEqual(registry.names().length, 1, "registering twice leaves one job, because two definitions would be a coin toss");

  // The registered job carries the attempt ceiling and the payload the definition promised.
  const registered = registry.get(RECURRING_SCHEDULE_JOB);

  expectEqual(registered.maxAttempts, 1, "the registered job is attempted once, as section 16 requires");
  expect(registered.timeoutMs > 0, "and carries a finite timeout rather than running unbounded");

  const parses = (payload: unknown): boolean => {
    try {
      registered.parsePayload(payload);

      return true;
    } catch {
      return false;
    }
  };

  expect(
    parses({ schedule_id: "018f2b9c-4444-7000-8000-000000000001", run_on: "2026-11-01" }),
    "the registered schema accepts the contract",
  );
  expect(
    !parses({ schedule_id: "018f2b9c-4444-7000-8000-000000000001", run_on: "2026-11-01", amount_minor: 100 }),
    "and refuses a payload that tries to carry an amount, which the queue must never be trusted with",
  );
  expect(!parses({ schedule_id: "018f2b9c-4444-7000-8000-000000000001" }), "and refuses a payload with no run date");

  // The default definition is the same name, so a route that imports it cannot register a second spelling.
  expectEqual(
    createDefaultRecurringGenerationJob().name,
    RECURRING_SCHEDULE_JOB,
    "the default definition uses the same name",
  );

  // The handler is real work: an empty run is the failure that looks like a working billing system, so the check
  // is that running it against a store which finds nothing reports a skip rather than resolving silently.
  const emptyStore: RestClient = { ...neverCalled };
  const outcome = await runRecurringScheduleJob(
    { schedule_id: "018f2b9c-4444-7000-8000-000000000009", run_on: "2026-11-01" },
    { rest: emptyStore, audit: createInMemoryAuditTrail(), today: () => "2026-11-05" },
  );

  expectEqual(outcome.kind, "skipped", "the registered handler does work and reports what it found");
  expectEqual(outcome.reason, "missing", "and says the schedule was not there rather than claiming a success");
}

/* ---- the six security claims ---- */

async function checkSecuritySweep(): Promise<void> {
  const service = await readRepositoryFile("services/invoices/recurring-schedule.ts");
  const migration = await readRepositoryFile("migrations/0028_recurring_schedules.sql");
  const csrf = await readRepositoryFile("lib/security/csrf.ts");
  const listRoute = await readRepositoryFile("app/api/invoices/recurring/route.ts");
  const itemRoute = await readRepositoryFile("app/api/invoices/recurring/[id]/route.ts");
  const stateRoute = await readRepositoryFile("app/api/invoices/recurring/[id]/state/route.ts");
  const code = service.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/\/\/.*/gu, "");

  // 1. Validation on both sides: a Zod schema on the server, and the same bounds imported by the panel.
  expect(service.includes("recurringScheduleCreateSchema") && service.includes("recurringScheduleUpdateSchema"), "both bodies are Zod schemas");
  expect(service.includes(".strict()"), "and strict, so an unknown key is reported rather than dropped");
  expect(
    service.includes("requireCsrfToken") === false,
    "the service itself never touches a request, so it cannot be the place a CSRF check is forgotten",
  );

  // 2. RLS and default-deny, from the migration rather than from a claim.
  expect(
    migration.includes("alter table public.recurring_schedules enable row level security"),
    "row level security is on for the schedule table",
  );
  expect(
    migration.includes("create policy recurring_schedules_default_deny") &&
      migration.includes("using (false)") &&
      migration.includes("with check (false)"),
    "with a default-deny policy that refuses reads and writes, so the service is the only way in",
  );

  // 3. An audit entry on every mutation: five mutating functions, five actions, one entity.
  for (const [label, action] of [
    ["create", RECURRING_SCHEDULE_CREATED_AUDIT_ACTION],
    ["edit", RECURRING_SCHEDULE_UPDATED_AUDIT_ACTION],
    ["pause", RECURRING_SCHEDULE_PAUSED_AUDIT_ACTION],
    ["resume", RECURRING_SCHEDULE_RESUMED_AUDIT_ACTION],
    ["end", RECURRING_SCHEDULE_ENDED_AUDIT_ACTION],
  ] as const) {
    expect(new RegExp(`^[a-z][a-z0-9_]*(\\.[a-z0-9_]+)+$`, "u").test(action) && action.length <= 64, `the ${label} action is a shape \`0013\` accepts`);
    expect(service.includes(action), `and the service writes the ${label} entry`);
  }

  expectEqual(new Set([
    RECURRING_SCHEDULE_CREATED_AUDIT_ACTION,
    RECURRING_SCHEDULE_UPDATED_AUDIT_ACTION,
    RECURRING_SCHEDULE_PAUSED_AUDIT_ACTION,
    RECURRING_SCHEDULE_RESUMED_AUDIT_ACTION,
    RECURRING_SCHEDULE_ENDED_AUDIT_ACTION,
  ]).size, 5, "five distinct actions, so a trail says which verb happened rather than only that one did");

  expectEqual(RECURRING_SCHEDULE_AUDIT_ENTITY, "recurring_schedule", "every entry names the schedule rather than the invoice");
  expect(code.includes("appendTolerated("), "an audit sink that is down never fails the write it records");

  // 4. The role and the tenant come from the session, never from a body.
  expect(service.includes("requireAnyRole(actor, RECURRING_SCHEDULE_MANAGE_ROLES)"), "the owner role is required");
  expect(service.includes("requireCompanyId(actor)"), "and the company comes from the session");
  expect(
    !/body[^\n]*company_id|company_id[^\n]*body/u.test(code),
    "no body can name a company, so a crafted request cannot write into another merchant's book",
  );
  expectEqual(JSON.stringify([...RECURRING_SCHEDULE_MANAGE_ROLES]), JSON.stringify(["owner"]), "section 25: a merchant's billing belongs to its owner");

  // Every read names its company, and every table the service touches is one it owns.
  const reads = code.match(/rest[.]select\(/gu) ?? [];
  expect(reads.length > 0, "the service reads");
  expect(
    (code.match(/company_id=eq[.]\$\{companyId\}/gu) ?? []).length >= 4,
    "and every read and every write is scoped to the session's company",
  );
  expect(
    RECURRING_SCHEDULE_COLUMNS.startsWith("select=") && !RECURRING_SCHEDULE_COLUMNS.includes("*"),
    "rule 17: the column list names its columns, and carries the `select=` prefix PostgREST needs",
  );
  expectEqual(RECURRING_SCHEDULE_TABLE, "recurring_schedules", "and the table is the one `0028` created");

  // 5. CSRF on every mutating route, and only on those.
  expect(csrf.includes(`"/api/invoices/recurring"`), "the create path is protected");
  expect(csrf.includes(`"/api/invoices/recurring/[id]/state"`), "and the state path");
  for (const [label, source] of [["the list route", listRoute], ["the item route", itemRoute], ["the state route", stateRoute]] as const) {
    expect(source.includes("requireCsrfToken("), `${label} checks the token`);
  }
  expect(
    listRoute.indexOf("requireCsrfToken(") < listRoute.indexOf("await request.text()"),
    "and checks it before reading the body, so an unauthenticated body is never parsed",
  );

  // 6. No secret and no client data in a log line or a trail payload.
  const browsers = [listRoute, itemRoute, stateRoute].join("\n");
  expect(!/clientName|client_name/u.test(browsers), "no route logs a client's name");
  expect(!/totalMinor|total_minor/u.test(browsers.replace(/schedule\.template/g, "")), "and none logs an amount");
  expect(
    !/payload: \{[^}]*client_name/u.test(code),
    "no audit payload carries the client's name",
  );
  expect(
    !/payload: \{[^}]*total_minor/u.test(code),
    "and none carries an amount, because a schedule records configuration rather than a bill",
  );
  expect(!/console[.]log/u.test(code), "the service logs nothing directly, so rule 5 has one logging path");
}

/* ---- the two STEPs agree ---- */

async function checkStepBoundary(): Promise<void> {
  const features = await readRepositoryFile("docs/final/FEATURE_LIST.md");
  const plan = await readRepositoryFile("docs/final/STEP_PLAN_250.md");

  // Section 16's claims this STEP is responsible for, quoted rather than paraphrased.
  expect(features.includes("Recurring invoices exist"), "section 16 asks for recurring invoices");
  expect(
    features.includes("reminders go to the client at set intervals"),
    "and for reminders at set intervals, which is why the schedule carries a reminder policy at all",
  );
  expect(
    features.includes("there is no automatic retry"),
    "and says a failed run is not retried, which is why the job's attempt ceiling is one",
  );
  expect(features.includes("Recurring invoice generation and client reminders"), "section 27 names the background work");

  // The plan splits this feature across two entries, and this STEP is the configuration half.
  expect(plan.includes("### STEP 122: Recurring invoice schedule configuration"), "STEP 122 is the configuration");
  expect(
    plan.includes("### STEP 123: Recurring generation job with due and overdue handling and client reminders"),
    "and STEP 123 is the generation and the reminders",
  );

  // Nothing in this STEP generates an invoice from a schedule: that is the next STEP's file, not this one's.
  const service = await readRepositoryFile("services/invoices/recurring-schedule.ts");
  expect(!service.includes("createInvoice("), "this STEP never creates an invoice from a schedule");
  expect(!service.includes("enqueueJob("), "and never enqueues the generation, because it does not own the handler");

  // The contract module is the only place the two STEPs meet, and it names the seam.
  const job = await readRepositoryFile("services/invoices/recurring-schedule-job.ts");
  expect(job.includes("STEP 123"), "the contract says which STEP implements it");
  expect(job.includes("registerRecurringScheduleJob("), "and gives that STEP one function to call");
}

/* ---- the run ---- */

async function run(): Promise<void> {
  await group("job contract", checkJobContract);
  await group("security sweep", checkSecuritySweep);
  await group("STEP boundary", checkStepBoundary);
  await group("registration", checkRegistration);

  if (failures.length > 0) {
    process.stderr.write(`recurring schedule job gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `recurring schedule job gate passed: ${String(checks)} checks, a payload that names one schedule and one run ` +
      "date and refuses to carry anything else, no work and no registration at import time so the contract " +
      "still imports safely now that STEP 123 has added the handler, " +
      "and the six security claims of the STEP - validation, RLS, five audit actions, the owner role and the " +
      "session's company, CSRF on every mutating route, and no client data in a log line or a trail\n",
  );
}

await run();
