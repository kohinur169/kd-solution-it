// path: services/payments/refund-execution-runtime.ts
import { z } from "zod";
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import { getGatewayRuntime } from "../../lib/gateways/runtime.ts";
import type { RefundProviderPorts, RefundProviderTarget } from "./refund-provider.ts";
import { createNmiRefundPort } from "./refund-nmi.ts";
import type { RefundExecutionDependencies } from "./refund-execution.ts";

/**
 * The production wiring of STEP 192: the database, the signed chain, and one refund port per provider.
 *
 * ## Where the provider's key comes from
 *
 * A refund has to be signed by the same gateway account that took the money, so the credential is read from
 * `provider_keys` - the table the gateway panel writes and seals. Two reads are tried in order:
 *
 *   1. `payments.provider_key_id`, when `0037` recorded the exact key that signed the original call. That is the
 *      originating credential by definition;
 *   2. the active key for the payment's provider and mode, because a key added after the payment, or a payment
 *      recorded without one, must still be refundable through the account that is on today.
 *
 * ## Why the box is opened here and not in the port
 *
 * `lib/gateways/runtime.ts` already holds the one cipher this repository uses for stored secrets
 * (`lib/auth/secrets.ts`, AES-256-GCM with the master key in `ENCRYPTION_MASTER_KEY`), and the context a box was
 * sealed under - `provider_keys:{providerKey}:{mode}:{fingerprint}` - is the gateways service's own formula,
 * repeated here because that function is private to its module. Opening it here means the port receives a
 * plaintext secret for the length of one call and the execution service never sees a key at all.
 *
 * A row that will not open (a rotated master key, a ciphertext copied between rows) is `null`, which the port
 * turns into `refund_provider_key_missing`: the refund goes back to `approved`, no provider is asked, and the
 * desk reads a rule it can fix.
 *
 * ## What this module does not wire
 *
 * Stripe, Airwallex, Rainforest and Payoneer. `REFUNDING_PROVIDER_KEYS` is `["nmi"]` and says so; a refund of a
 * payment taken through any of the other four is refused before a status moves. Adding one is a port factory
 * and a line in the record below.
 */

/** The columns a sealed provider key is read through. Never selected outside this module. */
const providerKeySchema = z.object({
  id: z.string().min(1).max(64),
  provider_id: z.string().min(1).max(64),
  mode: z.enum(["test", "live"]),
  status: z.enum(["active", "disabled"]),
  key_fingerprint: z.string().length(64),
  key_ciphertext: z.string().min(1).max(8_192),
  key_iv: z.string().min(1).max(64),
  key_tag: z.string().min(1).max(64),
});

const PROVIDER_KEY_COLUMNS =
  "select=id,provider_id,mode,status,key_fingerprint,key_ciphertext,key_iv,key_tag";

/** The context a provider key's box is sealed under: the gateways service's own formula. */
function providerKeyContext(providerKey: string, mode: "test" | "live", fingerprint: string): string {
  return `provider_keys:${providerKey}:${mode}:${fingerprint}`;
}

/**
 * The secret for one refund, or null when this deployment holds no usable key for it.
 *
 * `providerKeyId` is tried first and its own `mode` is ignored: the row that signed the payment decides, even if
 * the platform has since moved on to a different active key in that mode.
 */
async function readOriginatingSecret(target: RefundProviderTarget): Promise<{ secretKey: string } | null> {
  const runtime = getAuthRuntime();
  const rows =
    target.providerKeyId === null
      ? await runtime.rest.select(
          "provider_keys",
          `${PROVIDER_KEY_COLUMNS}&provider_id=eq.${target.providerId}&mode=eq.${target.mode}` +
            "&company_id=is.null&deleted_at=is.null&order=updated_at.desc&limit=5",
          providerKeySchema,
        )
      : await runtime.rest.select(
          "provider_keys",
          `${PROVIDER_KEY_COLUMNS}&id=eq.${target.providerKeyId}&company_id=is.null&deleted_at=is.null&limit=1`,
          providerKeySchema,
        );

  // The originating key is used as it stands; a fallback read takes the newest active key in the payment's mode,
  // because a disabled key is not a credential any more.
  const row = target.providerKeyId === null ? rows.find((candidate) => candidate.status === "active") : rows[0];

  if (row === undefined || row.status !== "active") {
    return null;
  }

  try {
    const secretKey = getGatewayRuntime().secrets.open(
      { ciphertext: row.key_ciphertext, iv: row.key_iv, tag: row.key_tag },
      providerKeyContext(target.providerKey, row.mode, row.key_fingerprint),
    );

    return secretKey.trim().length === 0 ? null : { secretKey };
  } catch {
    // A box that will not open is a configuration this desk can see and fix, never a reason to half-execute.
    return null;
  }
}

/** The dependencies the execute route uses: the service's three, plus the ports this build can drive. */
export type RefundExecutionRuntime = RefundExecutionDependencies & { readonly now: () => number };

/** Build the ports once per request, from the one cipher and the adapter's own transport. */
export function refundProviderPorts(): RefundProviderPorts {
  return {
    nmi: createNmiRefundPort({ secret: readOriginatingSecret }),
  };
}

export function getRefundExecutionRuntime(): RefundExecutionRuntime {
  const runtime = getAuthRuntime();

  return {
    rest: runtime.rest,
    audit: runtime.audit,
    providers: refundProviderPorts(),
    now: (): number => Date.now(),
  };
}
