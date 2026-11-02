// path: lib/countries/registry.ts
import type { PlatformRole } from "../auth/types.ts";
import type { MessagePath } from "../i18n/messages.ts";
import { deepFreeze } from "../utils/freeze.ts";
import type { ApprovalActionType } from "../approvals/registry.ts";

/**
 * Section 3's country switch, as data: who may turn it, what state a country is in, and the three
 * sentences that refuse a turn.
 *
 * ## The two controllers, and why the third name is missing
 *
 * FEATURE_LIST section 3 says the platform-level country switch is "controlled by super_admin and
 * CEO", and section 2 gives the CEO "country and pricing decisions taken with the super
 * administrator". Both names, and nobody else: compliance screens a merchant's country, finance
 * answers questions about a payout destination, support repeats what the screen says, and none of
 * the three may open or close a market.
 *
 * The pair is the same pair that signs at the two desks of the approval chain, which is not a
 * coincidence: a country opening is one of the four actions that needs two signatures. The constant
 * is written here rather than imported from `lib/approvals/registry.ts` because the two rules answer
 * different questions - who may *see and turn* the switch, and who may *sign* - and the gate asserts
 * they currently agree instead of letting one silently become the other.
 *
 * ## Three states, not two
 *
 * A country is enabled, disabled, or sanctioned. The third is not a flavour of the second: a
 * sanctioned row is off because of a comprehensive embargo, the database refuses to enable it
 * (`countries_sanctioned_disabled_check`), the guard trigger freezes the flag that says so, and the
 * platform's answer to "when will it open" is never. Folding the two together would let a screen
 * offer a switch that can only fail.
 */

/** The two roles section 3 gives the switch to. Order matches the approval chain's queue roles. */
export const COUNTRY_SWITCH_ROLES: readonly PlatformRole[] = deepFreeze([
  "ceo",
  "super_admin",
] as const satisfies readonly PlatformRole[]);

/** The action this switch spends. `0095` fixes it as one of the four the chain carries. */
export const COUNTRY_ENABLE_ACTION: ApprovalActionType = "country_enable";

/** The three observable states of one row. */
export type CountrySwitchState = "enabled" | "disabled" | "sanctioned";

/** The six states a country row can be in, named from its two flags. */
export function countrySwitchStateOf(input: {
  readonly isEnabled: boolean;
  readonly isSanctioned: boolean;
}): CountrySwitchState {
  if (input.isSanctioned) {
    return "sanctioned";
  }

  return input.isEnabled ? "enabled" : "disabled";
}

const stateLabelKeys: Readonly<Record<CountrySwitchState, MessagePath>> = deepFreeze({
  enabled: "officeCountries.stateEnabled",
  disabled: "officeCountries.stateDisabled",
  sanctioned: "officeCountries.stateSanctioned",
});

/** The catalog key of a state's badge, so the list and the panel word it the same way. */
export function countryStateLabelKey(state: CountrySwitchState): MessagePath {
  return stateLabelKeys[state];
}

/**
 * Why a country may not be opened, or null when it may.
 *
 * `approval_required` is the rule that makes section 3's "controlled by" true rather than a label:
 * the switch is not the operator's own signature, it is the signature of a decision two people
 * already took. An approval is spent when it is used (`consumed_at`), so one decision opens one
 * market once.
 */
export function enableProblemOf(input: {
  readonly state: CountrySwitchState;
  readonly hasApproval: boolean;
}): "sanctioned" | "already_on" | "approval_required" | null {
  if (input.state === "sanctioned") {
    return "sanctioned";
  }

  if (input.state === "enabled") {
    return "already_on";
  }

  return input.hasApproval ? null : "approval_required";
}

/**
 * Why a country may not be closed, or null when it may.
 *
 * Closing is the one direction the chain does not carry, and that is deliberate: a sanctions
 * listing, a processor outage or a fraud wave is a reason to stop selling today, not in two
 * signatures' time. The act is still reasoned and audited, and it is still the two controllers'
 * alone. A sanctioned row is already closed and already carries its sentence, so it is not "closed
 * again".
 */
export function disableProblemOf(input: {
  readonly state: CountrySwitchState;
}): "sanctioned" | "already_off" | null {
  if (input.state === "sanctioned") {
    return "sanctioned";
  }

  return input.state === "enabled" ? null : "already_off";
}

/**
 * Why an opening may not be asked for, or null when it may.
 *
 * A country that is already on needs no decision, a sanctioned one can never have one, and a request
 * already in the chain would be the same ask twice - which the partial unique index would refuse a
 * moment later anyway.
 */
export function requestProblemOf(input: {
  readonly state: CountrySwitchState;
  readonly hasLiveRequest: boolean;
}): "sanctioned" | "already_on" | "already_pending" | null {
  if (input.state === "sanctioned") {
    return "sanctioned";
  }

  if (input.state === "enabled") {
    return "already_on";
  }

  return input.hasLiveRequest ? "already_pending" : null;
}

/** The audit name of a country being opened. Satisfies the platform's dotted action rule. */
export const COUNTRY_ENABLED_AUDIT_ACTION = "country.enabled";

/** The audit name of a country being closed. */
export const COUNTRY_DISABLED_AUDIT_ACTION = "country.disabled";

/** The two audit names, so the gate can walk them. */
export const COUNTRY_AUDIT_ACTIONS: readonly string[] = deepFreeze([
  COUNTRY_ENABLED_AUDIT_ACTION,
  COUNTRY_DISABLED_AUDIT_ACTION,
]);

/**
 * The shortest sentence worth recording beside a closed market.
 *
 * `countries_disabled_reason_check` allows ten to two hundred and eighty characters, and requires
 * the sentence exactly while the country is off. "Closed" is not a reason; "closed while the
 * processor reviews March chargebacks" is.
 */
export const COUNTRY_DISABLE_REASON_MINIMUM_LENGTH = 10;

/** The longest sentence the column holds. */
export const COUNTRY_DISABLE_REASON_MAXIMUM_LENGTH = 280;

/**
 * How many rows one read returns.
 *
 * The ISO 3166-1 list plus Kosovo is 250 rows, so this is the whole list with room for the way
 * reference lists grow. It is a bound rather than a page because a country picker that pages is a
 * picker that hides the row somebody needs.
 */
export const COUNTRY_SWITCH_LIMIT = 300;

/** An ISO 3166-1 alpha-2 code, as `countries_code_check` requires. */
export const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/u;
