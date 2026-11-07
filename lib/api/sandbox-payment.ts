// path: lib/api/sandbox-payment.ts
import { z } from "zod";
import type { AuditEntry, AuditTrail } from "../auth/audit.ts";
import type { RestClient } from "../auth/rest.ts";
import { AppError, type ErrorDetail } from "../errors/app-error.ts";
import { API_PAYMENT_OBJECT, type ApiPaymentMethod } from "./payment-fields.ts";
import type { ApiPrincipal } from "./public-fields.ts";
import {
  API_PAYMENT_STATUS_COLUMNS,
  API_PAYMENT_STATUS_RULES,
  API_STORE_PAYMENT_STATUSES,
  parsePaymentId,
  type ApiStorePaymentStatus,
  type ApiStorePaymentStatusView,
} from "./store-payment-status.ts";
import {
  API_SANDBOX_AUDIT,
  API_SANDBOX_BODY_FIELD,
  API_SANDBOX_BODY_MAXIMUM_BYTES,
  API_SANDBOX_CREDENTIAL_FIELD,
  API_SANDBOX_ENTITY,
  API_SANDBOX_PAYMENT_TABLE,
  API_SANDBOX_READ_COLUMNS,
  API_SANDBOX_RULES,
  API_SANDBOX_SCENARIO_FIELD,
  API_SANDBOX_SIMULABLE_STATUSES,
  API_SANDBOX_VERIFY_COLUMNS,
  isSandboxScenario,
  sandboxPatchFor,
  type ApiSandboxScenario,
  type ApiSandboxSimulationRequest,
} from "./sandbox-fields.ts";

/**
 * Section 8's sandbox payment, simulated on a test credential.
 *
 * ## What this call does, in one sentence
 *
 * A store that created a `pending` payment with a **test** key says what its test checkout should have produced -
 * `captured`, `declined` or `review` - and the platform moves that one test payment to the matching state, writes
 * one chain entry, and answers with the same body STEP 204 serves.
 *
 * ## The two fences, and why they are in this order
 *
 * **The credential first.** A live key is refused with `403` before the body is read and before a query is made,
 * because a live payment is a payment somebody's card paid for. This is what section 8's *"separate test
 * credentials"* buys: the mode is inside the key, the pipeline proved the key, and the mode it proved decides
 * whether this surface exists at all.
 *
 * **The literal mode second.** Every query below says `mode=eq.test` as a constant rather than splicing the
 * principal's mode into the filter. Two independent facts then have to fail before a live row is touched, and if
 * the first fence were ever removed in a refactor the second still refuses.
 *
 * ## Why the write is a compare-and-set
 *
 * A payment that two simulations reach at once must not be written twice: the second would overwrite the first's
 * instants and the store would be told about an outcome that is not the row's. So the row is read with its
 * `version`, the update filters on that version, and a read-back proves the version advanced by exactly one. The
 * idiom is the platform's - `lib/announcements/service.ts` writes its rows the same way - and it is the only
 * reason this service reads the row twice.
 *
 * ## What a simulation never does
 *
 * It writes no ledger entry, no fee, no platform fee, no refunded total, no settlement hold, no provider
 * transaction id and no card field: *"Test payments move no real money"* is a property of the patch table, and the
 * gate proves the patch cannot name a money column. It also does not deliver a webhook - section 8's *"simulated
 * webhooks"* are STEP 207's surface - and it never touches a payment of another merchant, of another mode, or one
 * that belongs to an invoice.
 */

/** What this service needs from the outside world, injected so the gate can drive it without a database. */
export interface SandboxSimulationDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now: () => number;
}

/** One simulation: the id from the path, the caller the pipeline proved, and what they asked for. */
export interface SandboxSimulationInput {
  readonly paymentId: string;
  readonly principal: ApiPrincipal;
  readonly clientAddress: string | null;
  readonly request: ApiSandboxSimulationRequest;
}

/** What a simulation answers: STEP 204's view, and the state it moved from. */
export interface SandboxSimulationOutcome {
  readonly status: 200;
  readonly body: ApiStorePaymentStatusView;
  readonly scenario: ApiSandboxScenario;
  readonly previousStatus: ApiStorePaymentStatus;
}

const readSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(API_STORE_PAYMENT_STATUSES),
  mode: z.enum(["test", "live"]),
  version: z.number().int().positive(),
});

const verifySchema = z.object({
  id: z.string().uuid(),
  status: z.enum(API_STORE_PAYMENT_STATUSES),
  amount_minor: z.number().int(),
  refunded_minor: z.number().int(),
  currency: z.string(),
  mode: z.enum(["test", "live"]),
  payment_method: z.enum(["card", "bank_transfer", "e_wallet"]),
  failure_code: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  version: z.number().int().positive(),
});

type VerifiedRow = z.infer<typeof verifySchema>;

/**
 * The fence of section 8, as a predicate.
 *
 * Pure and separate from the write that pairs it with a chain entry, so the gate can prove the refusal's code, field
 * and rule without a trail to write to.
 */
export function assertTestCredential(principal: ApiPrincipal): void {
  if (principal.mode !== "test") {
    throw new AppError("PERMISSION_DENIED", {
      details: [{ field: API_SANDBOX_CREDENTIAL_FIELD, rule: API_SANDBOX_RULES.liveCredential }],
    });
  }
}

/**
 * The body, read once, bounded twice - the shape STEP 203 reads a payment's body with.
 *
 * A declared `Content-Length` past the ceiling is refused without reading the stream; a chunked body is counted as
 * it is read. JSON that does not parse is a `body_malformed` refusal rather than the framework's error page.
 */
export async function readSandboxBody(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");

  if (declared !== null && Number.parseInt(declared, 10) > API_SANDBOX_BODY_MAXIMUM_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE", {
      details: [{ field: API_SANDBOX_BODY_FIELD, rule: API_SANDBOX_RULES.bodyTooLarge }],
    });
  }

  const text = await request.text();

  if (new TextEncoder().encode(text).length > API_SANDBOX_BODY_MAXIMUM_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE", {
      details: [{ field: API_SANDBOX_BODY_FIELD, rule: API_SANDBOX_RULES.bodyTooLarge }],
    });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: API_SANDBOX_BODY_FIELD, rule: API_SANDBOX_RULES.bodyMalformed }],
    });
  }
}

/**
 * Refuse a live credential, and record that you did.
 *
 * The route calls this **before** it reads a body, so a live key costs this platform nothing beyond the
 * authentication STEP 202 already performed; the service calls it again, because a fence that lives only in a route
 * is a fence the next route forgets. A test credential passes through silently - it is the caller this endpoint was
 * built for.
 */
export async function guardTestCredential(
  principal: ApiPrincipal,
  dependencies: { readonly audit: AuditTrail; readonly clientAddress: string | null },
): Promise<void> {
  if (principal.mode === "test") {
    return;
  }

  const entry: AuditEntry = {
    action: API_SANDBOX_AUDIT.refused,
    actorUserId: null,
    entityType: API_SANDBOX_ENTITY,
    entityId: null,
    payload: {
      rule: API_SANDBOX_RULES.liveCredential,
      scenario: null,
      mode: principal.mode,
      credential_id: principal.credentialId,
    },
    companyId: principal.companyId,
    sessionId: null,
    ipAddress: dependencies.clientAddress,
    userAgent: null,
  };

  try {
    await dependencies.audit.append(entry);
  } catch {
    // The refusal is the answer. A chain that cannot be written does not make a live payment simulable.
  }

  assertTestCredential(principal);
}

const requestSchema = z.strictObject({ scenario: z.string() });

/**
 * The request as a typed value, or a refusal that names one field and one rule.
 *
 * Strict, for STEP 203's reason: a body carrying `status`, `amount_minor`, `three_ds_outcome` or anything else is
 * refused rather than ignored, because a field the platform silently drops is a field a client believes it set -
 * and on this endpoint the fields it named are the columns a simulation is designed not to let anyone choose.
 *
 * A body with no `scenario` key is its own word (`scenario_missing`) rather than a shape error: a store that sent
 * `{}` has one fix to make, and telling it "malformed" would hide which fix.
 */
export function parseSandboxSimulationRequest(value: unknown): ApiSandboxSimulationRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("scenario" in value)
  ) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: API_SANDBOX_SCENARIO_FIELD, rule: API_SANDBOX_RULES.scenarioMissing }],
    });
  }

  const parsed = requestSchema.safeParse(value);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", { details: detailsOf(parsed.error) });
  }

  if (!isSandboxScenario(parsed.data.scenario)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: API_SANDBOX_SCENARIO_FIELD, rule: API_SANDBOX_RULES.scenarioUnsupported }],
    });
  }

  return { scenario: parsed.data.scenario };
}

/** Zod's issues as the platform's `{field, rule}` details, one per field, first issue wins. */
function detailsOf(error: z.ZodError): readonly ErrorDetail[] {
  const details: ErrorDetail[] = [];

  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        if (!details.some((detail) => detail.field === key)) {
          details.push({ field: key, rule: API_SANDBOX_RULES.unknownField });
        }
      }
    }
  }

  if (details.length === 0) {
    details.push({
      field: API_SANDBOX_SCENARIO_FIELD,
      rule: API_SANDBOX_RULES.scenarioUnsupported,
    });
  }

  return details;
}

/** One line in the chain for a simulation the platform did not perform. */
async function noteRefusedSimulation(
  dependencies: SandboxSimulationDependencies,
  principal: ApiPrincipal,
  input: SandboxSimulationInput,
  paymentId: string | null,
  rule: string,
): Promise<void> {
  const entry: AuditEntry = {
    action: API_SANDBOX_AUDIT.refused,
    actorUserId: null,
    entityType: API_SANDBOX_ENTITY,
    entityId: paymentId,
    payload: {
      rule,
      scenario: isSandboxScenario(input.request.scenario) ? input.request.scenario : null,
      mode: principal.mode,
      credential_id: principal.credentialId,
    },
    companyId: principal.companyId,
    sessionId: null,
    ipAddress: input.clientAddress,
    userAgent: null,
  };

  try {
    await dependencies.audit.append(entry);
  } catch {
    // The refusal is the answer. A chain that cannot be written does not make a live payment simulable.
  }
}

/** One line in the chain for a simulation that landed: what moved, and in which mode. */
async function noteSimulation(
  dependencies: SandboxSimulationDependencies,
  principal: ApiPrincipal,
  input: SandboxSimulationInput,
  from: ApiStorePaymentStatus,
  to: ApiStorePaymentStatus,
): Promise<void> {
  const entry: AuditEntry = {
    action: API_SANDBOX_AUDIT.simulated,
    actorUserId: null,
    entityType: API_SANDBOX_ENTITY,
    entityId: input.paymentId,
    payload: {
      scenario: input.request.scenario,
      from_status: from,
      to_status: to,
      mode: principal.mode,
      credential_id: principal.credentialId,
    },
    companyId: principal.companyId,
    sessionId: null,
    ipAddress: input.clientAddress,
    userAgent: null,
  };

  try {
    await dependencies.audit.append(entry);
  } catch {
    // The simulation happened. A chain that cannot be written does not undo a test payment's state.
  }
}

/**
 * The row as STEP 204 serves it.
 *
 * Written here rather than imported because STEP 204 keeps its builder private, and the gate pins the ten field
 * names against `API_PAYMENT_STATUS_COLUMNS` so the two answers cannot drift apart without a red gate.
 */
function viewOf(row: VerifiedRow): ApiStorePaymentStatusView {
  return {
    id: row.id,
    object: API_PAYMENT_OBJECT,
    status: row.status,
    amount_minor: row.amount_minor,
    refunded_minor: row.refunded_minor,
    currency: row.currency,
    mode: row.mode,
    payment_method: row.payment_method as ApiPaymentMethod,
    failure_code: row.failure_code,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** The filter every query of this service shares: one payment, one merchant, test mode, not on an invoice, alive. */
function scopeOf(paymentId: string, companyId: string): string {
  return (
    `id=eq.${encodeURIComponent(paymentId)}` +
    `&company_id=eq.${encodeURIComponent(companyId)}` +
    "&mode=eq.test&invoice_id=is.null&deleted_at=is.null"
  );
}

/**
 * Simulate one test payment's outcome, or refuse it.
 *
 * Three queries and one write: the row with its version, the compare-and-set update, and the read-back that both
 * proves the version advanced and supplies the answer. No other table is touched, which is what keeps a test
 * payment out of the ledger.
 */
export async function simulateTestPayment(
  input: SandboxSimulationInput,
  dependencies: SandboxSimulationDependencies,
): Promise<SandboxSimulationOutcome> {
  // The fence again, before the first query: the route already called it, and a service that trusts its caller is
  // one refactor away from simulating a live payment.
  await guardTestCredential(input.principal, {
    audit: dependencies.audit,
    clientAddress: input.clientAddress,
  });

  let paymentId: string;

  try {
    paymentId = parsePaymentId(input.paymentId);
  } catch (error) {
    await noteRefusedSimulation(
      dependencies,
      input.principal,
      input,
      null,
      API_PAYMENT_STATUS_RULES.malformed,
    );

    throw error;
  }

  const rows = await dependencies.rest.select(
    API_SANDBOX_PAYMENT_TABLE,
    `select=${API_SANDBOX_READ_COLUMNS}&${scopeOf(paymentId, input.principal.companyId)}&limit=1`,
    readSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    await noteRefusedSimulation(
      dependencies,
      input.principal,
      input,
      paymentId,
      API_PAYMENT_STATUS_RULES.notFound,
    );

    // One answer for five states, STEP 204's: unknown, another merchant's, another mode's, an invoice payment, a
    // deleted one. A live payment reached with a test key is therefore not a permission error - it does not exist.
    throw new AppError("RESOURCE_NOT_FOUND", {
      details: [{ field: "id", rule: API_PAYMENT_STATUS_RULES.notFound }],
    });
  }

  if (!(API_SANDBOX_SIMULABLE_STATUSES as readonly string[]).includes(row.status)) {
    await noteRefusedSimulation(
      dependencies,
      input.principal,
      input,
      paymentId,
      API_SANDBOX_RULES.paymentAlreadyDecided,
    );

    throw new AppError("CONFLICT", {
      details: [{ field: "payment.status", rule: API_SANDBOX_RULES.paymentAlreadyDecided }],
    });
  }

  const instantIso = new Date(dependencies.now()).toISOString();
  const patch = sandboxPatchFor(input.request.scenario, instantIso);

  await dependencies.rest.update(
    API_SANDBOX_PAYMENT_TABLE,
    `${scopeOf(paymentId, input.principal.companyId)}&version=eq.${String(row.version)}`,
    patch,
  );

  const after = await dependencies.rest.select(
    API_SANDBOX_PAYMENT_TABLE,
    `select=${API_SANDBOX_VERIFY_COLUMNS}&${scopeOf(paymentId, input.principal.companyId)}&limit=1`,
    verifySchema,
  );
  const written = after[0];

  if (
    written === undefined ||
    written.version !== row.version + 1 ||
    written.status !== patch["status"]
  ) {
    // Either the row vanished between the two reads or another writer won the compare-and-set. A version that moved
    // by one is not proof enough on its own - the winner's write bumps it just as ours would - so the read-back also
    // requires the row to hold the status this scenario asked for. Both failures are a conflict, not a server fault.
    await noteRefusedSimulation(
      dependencies,
      input.principal,
      input,
      paymentId,
      API_SANDBOX_RULES.simulationRace,
    );

    throw new AppError("CONFLICT", {
      details: [{ field: "payment", rule: API_SANDBOX_RULES.simulationRace }],
    });
  }

  await noteSimulation(dependencies, input.principal, input, row.status, written.status);

  return {
    status: 200,
    body: viewOf(written),
    scenario: input.request.scenario,
    previousStatus: row.status,
  };
}

/** The ten field names STEP 204 serves, in its order, so a gate can compare this answer's keys without a literal. */
export function paymentViewFieldNames(): readonly string[] {
  return API_PAYMENT_STATUS_COLUMNS.split(",");
}
