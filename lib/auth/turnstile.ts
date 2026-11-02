// path: lib/auth/turnstile.ts
import { z } from "zod";
import { classifyAuthAnswer } from "./failures.ts";
import type { AuthHttp } from "./http.ts";
import type { PlatformSettings } from "./settings.ts";
import type { AuthFailure, AuthOutcome } from "./types.ts";

/**
 * Cloudflare Turnstile, which section 22 runs on signup, login and password reset.
 *
 * The verification is a server side call to Cloudflare with the token the widget produced and the
 * secret of the deployment; the browser is never the thing that decides whether the browser is
 * human. The secret is read from `platform_settings` (`turnstile.secret_key`, AES-256-GCM) and the
 * switch is `turnstile.enabled`, which is seeded closed by `0080`.
 *
 * ## The one rule that is a policy, not a check
 *
 * A deployment that has not turned Turnstile on is a deployment where signup would be open to a
 * bot, so the guard does not silently skip a closed switch in production: it answers an upstream
 * failure and the route refuses the request. In development and test the switch is honestly off and
 * the guard reports `skipped`, which is what lets a developer sign up on a laptop with no Cloudflare
 * account. Nothing else about the flow changes between the two.
 *
 * ## What a rejection looks like
 *
 * A token Cloudflare does not accept is `rejected`, exactly like a wrong password: the caller maps
 * it to a validation failure and the merchant sees a form error, not an explanation of the
 * challenge. Cloudflare's own error codes are kept on the failure for the log and never shown.
 */

export const TURNSTILE_SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export const TURNSTILE_ENABLED_SETTING = "turnstile.enabled";
export const TURNSTILE_SECRET_SETTING = "turnstile.secret_key";

/** A widget token is a few hundred characters. The ceiling stops a form being a payload. */
const maximumTokenLength = 2_048;

/** Longest remote address this guard will forward. Enough for IPv6 with a mapped IPv4 tail. */
const maximumRemoteIpLength = 45;

const enabledSchema = z.boolean();

const siteverifySchema = z.object({
  success: z.boolean(),
  "error-codes": z.array(z.string().min(1).max(64)).max(20).optional(),
  challenge_ts: z.string().max(40).optional(),
  hostname: z.string().max(255).optional(),
  action: z.string().max(64).optional(),
});

/** `verified` when a token was accepted, `skipped` when the deployment has the switch off. */
export type TurnstileDecision = "verified" | "skipped";

export interface TurnstileChallenge {
  /** The token the widget produced, or null when the form sent none. */
  readonly token: string | null;
  /** The address the request came from, when the deployment can see it. */
  readonly remoteIp: string | null;
}

export interface TurnstileGuard {
  check(challenge: TurnstileChallenge): Promise<AuthOutcome<TurnstileDecision>>;
}

export interface TurnstileGuardOptions {
  readonly settings: PlatformSettings;
  readonly http: AuthHttp;
  /** True in production, where a closed switch is a misconfiguration rather than a choice. */
  readonly isProduction: boolean;
  /** The siteverify URL. Overridden by the gate so no proof needs a network. */
  readonly endpoint?: string;
}

function failureOf(
  kind: AuthFailure["kind"],
  status: number | null = null,
  code: string | null = null,
): AuthFailure {
  return { kind, status, code, retryAfterSeconds: null };
}

export function createTurnstileGuard(options: TurnstileGuardOptions): TurnstileGuard {
  const endpoint = options.endpoint ?? TURNSTILE_SITEVERIFY_URL;

  return {
    async check(challenge: TurnstileChallenge): Promise<AuthOutcome<TurnstileDecision>> {
      const enabled = await options.settings.readValue(TURNSTILE_ENABLED_SETTING, enabledSchema);

      if (enabled !== true) {
        // A closed switch in production is the go-live item of section 34, not a permission to
        // accept every signup.
        return options.isProduction
          ? { ok: false, failure: failureOf("upstream") }
          : { ok: true, value: "skipped" };
      }

      const token = challenge.token?.trim() ?? "";

      if (token.length === 0 || token.length > maximumTokenLength) {
        return { ok: false, failure: failureOf("rejected") };
      }

      const secret = await options.settings.readSecret(TURNSTILE_SECRET_SETTING);

      if (secret === null) {
        return { ok: false, failure: failureOf("upstream") };
      }

      const remoteIp = challenge.remoteIp?.trim() ?? "";
      const form: Record<string, string> = { secret, response: token };

      if (remoteIp.length > 0 && remoteIp.length <= maximumRemoteIpLength) {
        form["remoteip"] = remoteIp;
      }

      const answer = await options.http.send({
        method: "POST",
        url: endpoint,
        // Siteverify authenticates with the secret in the body, and takes no Supabase key at all.
        apiKey: "",
        form,
        headers: { accept: "application/json" },
      });

      if (!answer.ok) {
        return { ok: false, failure: answer.failure };
      }

      const httpFailure = classifyAuthAnswer(answer.value);

      if (httpFailure !== null) {
        return { ok: false, failure: httpFailure };
      }

      const parsed = siteverifySchema.safeParse(answer.value.body);

      if (!parsed.success) {
        return { ok: false, failure: failureOf("malformed-response") };
      }

      if (!parsed.data.success) {
        const code = parsed.data["error-codes"]?.[0] ?? null;

        return { ok: false, failure: failureOf("rejected", answer.value.status, code) };
      }

      return { ok: true, value: "verified" };
    },
  };
}

/** An always-on guard for a deployment that has no Cloudflare account yet. */
export function createSkippingTurnstileGuard(): TurnstileGuard {
  return {
    check: (): Promise<AuthOutcome<TurnstileDecision>> =>
      Promise.resolve({ ok: true, value: "skipped" }),
  };
}
