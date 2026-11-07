// path: lib/api/store-webhook-runtime.ts
import { getAuthRuntime } from "../auth/runtime.ts";
import { openSecret, type SecretBox } from "../auth/secrets.ts";
import { serverEnv } from "../env/server.ts";
import { getJobRuntime } from "../jobs/runtime.ts";
import {
  createStoreWebhookTransport,
  registerStoreWebhookJob,
  type StoreWebhookDeliveryDependencies,
  type StoreWebhookScheduleDependencies,
} from "./store-webhooks.ts";

/**
 * The production wiring of section 20's outbound webhooks.
 *
 * The same projection `public-runtime.ts` and `credential-runtime.ts` make - one factory over one validated
 * environment - with the two things a delivery needs that authentication does not: the ability to open a signing
 * secret, and a transport. Both are injected here and nowhere else, so a module that sends a webhook cannot keep a
 * decrypted secret after it has signed one body.
 *
 * The secret is opened under the tenant's associated data (`credentialSecretContext`), which is what makes a box
 * copied into another merchant's row fail to open rather than sign that merchant's deliveries.
 */
export function getStoreWebhookRuntime(): StoreWebhookDeliveryDependencies {
  const runtime = getAuthRuntime();
  const masterKey = serverEnv().ENCRYPTION_MASTER_KEY;

  return {
    rest: runtime.rest,
    audit: runtime.audit,
    now: (): number => Date.now(),
    openSecret: (box: SecretBox, context: string): string => openSecret(masterKey, box, context),
    send: createStoreWebhookTransport(),
  };
}

/** What scheduling needs: the process-wide queue for the state and the chain for the record. */
export function getStoreWebhookScheduleRuntime(): StoreWebhookScheduleDependencies {
  const runtime = getAuthRuntime();

  return {
    queue: getJobRuntime().queue,
    audit: runtime.audit,
    now: (): number => Date.now(),
  };
}

/**
 * Register this STEP's job on the platform's own runtime, once.
 *
 * A worker bootstrap calls this before it starts, and a second call is answered `false` rather than throwing: a
 * duplicate registration would make the handler that runs depend on import order, which is the foundation's own
 * rule.
 */
export function registerStoreWebhookJobOnPlatform(): boolean {
  return registerStoreWebhookJob(getJobRuntime().registry, getStoreWebhookRuntime());
}
