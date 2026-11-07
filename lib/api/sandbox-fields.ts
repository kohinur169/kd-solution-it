// path: lib/api/sandbox-fields.ts
import { deepFreeze } from "../utils/freeze.ts";
import { API_PAYMENTS_PATH } from "./payment-fields.ts";
import { API_AUTH_FIELD } from "./public-fields.ts";

/**
 * Section 8's sandbox, in the vocabulary the public API uses to speak it.
 *
 * ## The five sentences this module exists for
 *
 * Section 8 is short and each line is a rule:
 *
 *   - *"Every merchant has a Test and Sandbox mode with separate test credentials."* `0034` already keeps the two
 *     apart by `mode`, and `credential-fields.ts` already puts the mode inside the key itself, so a test key cannot
 *     be mistaken for a live one by the merchant or by this platform.
 *   - *"Test payments move no real money."* Nothing here writes a ledger row, a fee, a refund or a provider
 *     transaction. A simulation changes a *test* payment's state and nothing else.
 *   - *"Test and live data are fully separated."* Every query below narrows on the literal `test`, never on a mode
 *     that arrived in a request - so no live payment is reachable through this surface even if a fence above it
 *     fails.
 *   - *"Invoices, payment links, recurring invoices and store connections can all be exercised in test mode."*
 *     The store connection is this range's piece of that list: STEP 203 creates a `pending` payment, and this is
 *     the call that moves it to an outcome without a card and without a gateway.
 *   - *"Simulated webhooks let the merchant verify an integration."* That is STEP 207's surface, not this one; this
 *     module never claims it.
 *
 * ## Why a scenario word rather than a status
 *
 * A caller sends *what happened at the checkout*, not a row to write: `captured`, `declined` or `review`. The
 * mapping from that word to columns lives in one frozen table (`sandboxPatchFor`), so a client cannot set an
 * amount, a currency, a fee, a refund, a provider transaction or a card field through this endpoint, and a future
 * scenario is one entry rather than a new code path.
 *
 * The two words and the two statuses differ on purpose: `declined` writes `failed`, because the schema's status
 * vocabulary is the processor's, and `review` writes `under_review`, because that is where a manual decision waits.
 *
 * ## What a simulation is honest about
 *
 * A real capture carries a three dimensional secure authentication, and `0037` refuses a captured payment without
 * one (`payments_three_ds_capture_check`). A simulated capture therefore records `three_ds_outcome =
 * 'authenticated'`, which is what the *simulated provider* answered - and it records nothing else as if it had
 * happened: the postal code and IP country flags are not touched, no provider transaction id is invented, and the
 * row's `mode` is `test` for every reader to see.
 */

/** Where a store simulates a test payment. One path segment under a payment's own path. */
export const API_SANDBOX_PATH_SEGMENT = "simulate";

/** The route a simulation is counted and recorded under: a template, so one endpoint is one limiter bucket. */
export const API_SANDBOX_ROUTE = `${API_PAYMENTS_PATH}/{id}/${API_SANDBOX_PATH_SEGMENT}`;

/** The concrete path of one payment's simulation, for a client and a test to build the same string. */
export function sandboxPathOf(paymentId: string): string {
  return `${API_PAYMENTS_PATH}/${encodeURIComponent(paymentId)}/${API_SANDBOX_PATH_SEGMENT}`;
}

/**
 * The three outcomes a test checkout can be made to have.
 *
 * Frozen and closed: a scenario is a scripted provider answer, and an open vocabulary would be a caller writing
 * columns. Ordered as a checkout proceeds - success, refusal, and the one that waits for a human.
 */
export const API_SANDBOX_SCENARIOS = deepFreeze(["captured", "declined", "review"] as const);

export type ApiSandboxScenario = (typeof API_SANDBOX_SCENARIOS)[number];

/** Whether a word is one of the three scenarios. */
export function isSandboxScenario(value: unknown): value is ApiSandboxScenario {
  return typeof value === "string" && (API_SANDBOX_SCENARIOS as readonly string[]).includes(value);
}

/** The field a scenario refusal names. */
export const API_SANDBOX_SCENARIO_FIELD = "scenario";

/** The field a body refusal names when the problem is the body rather than the scenario. */
export const API_SANDBOX_BODY_FIELD = "body";

/**
 * The largest body this endpoint reads.
 *
 * One field of at most eight characters, so a kilobyte is already generous; a ceiling exists because a public
 * endpoint's body is attacker controlled, not because a caller needs the space.
 */
export const API_SANDBOX_BODY_MAXIMUM_BYTES = 1_024;

/**
 * The status a payment must be in before a simulation may move it.
 *
 * `pending` and nothing else. STEP 203 creates exactly that state, no call in this API can produce another, and a
 * payment a gateway already answered is not a payment a simulation may rewrite - which makes "one test payment,
 * one outcome" a property of the endpoint rather than a hope about its caller.
 */
export const API_SANDBOX_SIMULABLE_STATUSES = deepFreeze(["pending"] as const);

/** The status each scenario writes into `payments.status`, taken from the schema's own vocabulary. */
export const API_SANDBOX_RESULT_STATUSES = deepFreeze({
  captured: "captured",
  declined: "failed",
  review: "under_review",
} as const);

/**
 * The machine code a simulated decline records.
 *
 * `0037` requires a failed payment to carry a code between one and 64 characters, and section 18 keeps a
 * processor's free sentence out of the platform's tables. So the code is a closed word the platform owns, chosen
 * to be recognisable as a simulation's answer rather than a real gateway's.
 */
export const API_SANDBOX_DECLINE_CODE = "card_declined";

/** What a simulated decline is allowed to say, which is nothing: `failure_detail` stays null. */
export const API_SANDBOX_DECLINE_DETAIL = null;

/**
 * The three dimensional secure outcome a simulated capture records.
 *
 * `0037`'s `payments_three_ds_capture_check` refuses a captured payment that is neither authenticated nor
 * accompanied by matching postal code and IP country. A test payment has neither of those pieces of evidence -
 * there is no invoice to compare against - so the simulated provider answer is the authenticated one, recorded as
 * exactly that and nothing more.
 */
export const API_SANDBOX_CAPTURE_THREE_DS = "authenticated";

/** The risk decision a simulated review records, from `payments_risk_check`. */
export const API_SANDBOX_REVIEW_RISK = "review";

/**
 * The columns a scenario writes, as a frozen table.
 *
 * The keys are columns and the values are what goes in them; the instant fields are filled from one clock reading
 * so a capture cannot be authorized a millisecond after it was captured. Nothing outside this table is ever
 * written - which is why the amount, the currency, the fee, the refunded total, the provider transaction id and
 * every card column are absent: a simulation moves a state, not money.
 */
export function sandboxPatchFor(
  scenario: ApiSandboxScenario,
  instantIso: string,
): Readonly<Record<string, string | null>> {
  switch (scenario) {
    case "captured":
      return {
        status: API_SANDBOX_RESULT_STATUSES.captured,
        authorized_at: instantIso,
        captured_at: instantIso,
        three_ds_outcome: API_SANDBOX_CAPTURE_THREE_DS,
      };
    case "declined":
      return {
        status: API_SANDBOX_RESULT_STATUSES.declined,
        failed_at: instantIso,
        failure_code: API_SANDBOX_DECLINE_CODE,
        failure_detail: API_SANDBOX_DECLINE_DETAIL,
      };
    case "review":
      return {
        status: API_SANDBOX_RESULT_STATUSES.review,
        risk_decision: API_SANDBOX_REVIEW_RISK,
      };
  }
}

/**
 * The reasons a simulation is refused.
 *
 * Machine words, because a client branches on them: `scenario_missing`, `scenario_unsupported`, `body_malformed`,
 * `body_too_large` and `unknown_field` are the caller's mistake; `live_credential_not_simulable` is the fence of
 * section 8; `payment_already_decided` and `simulation_race` are about the row's state.
 */
export const API_SANDBOX_RULES = Object.freeze({
  scenarioMissing: "scenario_missing",
  scenarioUnsupported: "scenario_unsupported",
  bodyMalformed: "body_malformed",
  bodyTooLarge: "body_too_large",
  unknownField: "unknown_field",
  liveCredential: "live_credential_not_simulable",
  paymentAlreadyDecided: "payment_already_decided",
  simulationRace: "simulation_race",
} as const);

/** The two chain entries a simulation can write. The call entry STEP 202 writes is separate and always written. */
export const API_SANDBOX_AUDIT = Object.freeze({
  simulated: "api.sandbox_payment_simulated",
  refused: "api.sandbox_simulation_refused",
} as const);

/** The entity both chain entries name. */
export const API_SANDBOX_ENTITY = "payment";

/**
 * The field the live-credential refusal names.
 *
 * `authorization`, because the *key* is what is wrong: a live key is not a key that may simulate anything. Naming a
 * payment field would tell the caller their payment was wrong, and the payment may not even exist.
 */
export const API_SANDBOX_CREDENTIAL_FIELD = API_AUTH_FIELD;

/** What a store sends: one scenario word, and nothing else. */
export interface ApiSandboxSimulationRequest {
  readonly scenario: ApiSandboxScenario;
}

/**
 * The columns this surface reads before it writes.
 *
 * `version` is here because the write after it is a compare-and-set, and `status` because the state decides whether
 * a simulation is allowed at all. Selected rather than starred: a `select=*` on this table would read
 * `failure_detail`, a processor's sentence about a customer.
 */
export const API_SANDBOX_READ_COLUMNS = "id,status,mode,version";

/**
 * The columns read back after the write: STEP 204's ten, plus the version that proves the write landed.
 *
 * The ten are imported shape-for-shape from `store-payment-status.ts` by the service, so a simulation's answer and a
 * status read's answer cannot drift into two different bodies for one payment.
 */
export const API_SANDBOX_VERIFY_COLUMNS =
  "id,status,amount_minor,refunded_minor,currency,mode,payment_method,failure_code,created_at,updated_at,version";

/** The table this surface writes and reads, named once so a query string cannot drift from the migration. */
export const API_SANDBOX_PAYMENT_TABLE = "payments";
