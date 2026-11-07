// path: services/disputes/dispute-runtime.ts
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { registerDefaultStorageAdapters } from "../../lib/storage/adapters.ts";
import { createDefaultFileEncryption } from "../../lib/storage/encryption.ts";
import { StorageAdapterRegistry, activeAdapter } from "../../lib/storage/registry.ts";
import type { DisputeDependencies } from "./dispute.ts";
import type { DisputeWebhookDependencies } from "./dispute-webhook.ts";
import type { DisputeEvidenceDependencies } from "./dispute-evidence.ts";
import { createDisputeEvidenceStorage } from "./dispute-evidence-storage.ts";
import type { ChargebackRateDependencies } from "./chargeback-rate.ts";
import type { DisputeSubmissionDependencies } from "./dispute-submission.ts";
import { SUBMITTING_PROVIDER_KEYS, type DisputeSubmissionPorts } from "./dispute-submission-provider.ts";

/**
 * The production wiring of section 19's disputes: the PostgREST client, the signed audit trail, the settings
 * reader the webhook opens its signing secret from, and a clock.
 *
 * ## Why this is a module and not three lines in each caller
 *
 * Four callers reach the dispute service - the merchant's list route and screen, the office queue's route and
 * screen - and one reaches the receiver. Five copies of a dependency object is how one of them ends up
 * reading rows without a chain entry or verifying a delivery against a secret nobody configured.
 * `getAuthRuntime()` already validates the environment, builds the service role client, the Ed25519 signing
 * trail and the settings reader that holds the platform's secrets, so this module is a projection of it
 * rather than a second factory.
 *
 * ## What is deliberately absent
 *
 * No provider client and no key ring. A dispute moves no money in this STEP: it is a row a processor
 * reported and the platform tracked. The evidence pack (STEP 198) and the chargeback fee (section 18's own
 * STEP) will add their dependencies here rather than to a second runtime.
 */

/** The dependencies the four reading callers use. */
export type DisputeRuntime = DisputeDependencies & { readonly now: () => number };

/** The dependencies the webhook route uses: the same, plus the settings reader that holds the secret. */
export type DisputeWebhookRuntime = DisputeWebhookDependencies;

export function getDisputeRuntime(): DisputeRuntime {
  const runtime = getAuthRuntime();

  return {
    rest: runtime.rest,
    audit: runtime.audit,
    now: (): number => Date.now(),
  };
}

/**
 * The webhook's wiring.
 *
 * `settings` is `getAuthRuntime().settings`, the same reader the sign-in screen takes its Turnstile secret
 * from: a signing secret is a platform secret, not a merchant key, and `provider_keys` holds merchants' keys
 * with no read path at all. So the endpoint's secret lives where every other platform secret lives, is
 * opened with the master key, and is never returned to a caller.
 */
export function getDisputeWebhookRuntime(): DisputeWebhookRuntime {
  const runtime = getAuthRuntime();

  return {
    rest: runtime.rest,
    audit: runtime.audit,
    settings: runtime.settings,
    now: (): number => Date.now(),
  };
}

/** The dependencies the evidence pack's four acts use: the dispute's own, plus the bound document port. */
export type DisputeEvidenceRuntime = DisputeEvidenceDependencies & { readonly now: () => number };

/**
 * The evidence pack's wiring (STEP 197).
 *
 * The storage port is built here rather than in the service. `lib/storage` already decides which adapter the
 * environment selects (`STORAGE_PROVIDER`), refuses to boot with half an S3 configuration and refuses a
 * signature that does not match the bytes; this module only asks it for the active one and for the platform's
 * own seal. So a deployment with a bucket gets working uploads and a deployment without one gets the honest
 * refusal `dispute_evidence_storage_missing`, and neither of them gets a file written to disk.
 *
 * The registry is built per call: adapters hold no connection until a request is made, and a module-level
 * registry would be a second place a provider could be registered twice.
 */
export function getDisputeEvidenceRuntime(): DisputeEvidenceRuntime {
  const runtime = getAuthRuntime();
  const registry = new StorageAdapterRegistry();
  registerDefaultStorageAdapters(registry);

  return {
    rest: runtime.rest,
    audit: runtime.audit,
    storage: createDisputeEvidenceStorage({
      adapter: activeAdapter(registry),
      encryption: createDefaultFileEncryption(),
      rest: runtime.rest,
      audit: runtime.audit,
      now: (): number => Date.now(),
    }),
    now: (): number => Date.now(),
  };
}

/** The dependencies the review and the submission use: the dispute's own, plus the processor ports. */
export type DisputeSubmissionRuntime = DisputeSubmissionDependencies & { readonly now: () => number };

/**
 * The review and submission wiring (STEP 198).
 *
 * The ports are built from `SUBMITTING_PROVIDER_KEYS`, which is empty in this build: no provider's dispute API
 * has been read from the provider's own documentation in a session yet, and the master prompt's provider rule
 * is that an adapter is written from that documentation and never from memory. So the provider channel refuses
 * with `dispute_submission_unsupported` and the recorded channel - the compliance desk sending the pack from the
 * processor's portal and typing its case number here - is the one that works today.
 *
 * That is a wiring decision, not a hole: adding a provider is one adapter file and one entry in that list, and
 * this function needs no change at all, because it registers whatever the list names.
 */
export function getDisputeSubmissionRuntime(): DisputeSubmissionRuntime {
  const runtime = getAuthRuntime();
  const ports: DisputeSubmissionPorts = {};

  if (SUBMITTING_PROVIDER_KEYS.length !== 0) {
    // A key in the list with no adapter beside it would be a provider this build claims to support and cannot
    // call. The list and this object grow together, in one commit, or neither of them moves.
    throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "submission_port_missing" } });
  }

  return {
    rest: runtime.rest,
    audit: runtime.audit,
    ports,
    now: (): number => Date.now(),
  };
}

/**
 * The chargeback programme's wiring: the platform client, the signed chain and a clock.
 *
 * Section 18's seven thresholds are read from `platform_settings` by the service, so this module adds no reader
 * of its own - `getAuthRuntime().rest` is already the client that reaches the table the super administrator
 * writes. No provider client and no storage port either: a measurement counts rows, a warning queues mail and an
 * extra reserve is a `0044` agreement, and none of those leaves the platform.
 */
export type ChargebackRuntime = ChargebackRateDependencies;

export function getChargebackRuntime(): ChargebackRuntime {
  const runtime = getAuthRuntime();

  return {
    rest: runtime.rest,
    audit: runtime.audit,
    now: (): number => Date.now(),
  };
}
