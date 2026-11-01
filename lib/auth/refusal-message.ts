// path: lib/auth/refusal-message.ts
import { formatMessage, getMessage } from "../i18n/messages.ts";

/**
 * The sentence a `429` earns on a screen.
 *
 * `ERROR_CODES.RATE_LIMITED` already carries a message, and the response already carries `retry-after`,
 * but neither reaches a person usefully on its own: "too many requests" without a time is a dead end,
 * and a header is not something a browser shows. The platform's rule is that a screen owns its
 * wording, so this module turns the envelope's `retryAfterSeconds` into one of two sentences - minutes
 * when the wait is long enough to be measured in them, seconds otherwise.
 *
 * It is deliberately free of any Node import: it is called from client components, and
 * `lib/auth/rate-limit.ts` - which hashes with `node:crypto` - must never be part of a browser bundle.
 */

/** The wait an error envelope names, or null when it names none the screen can use. */
export function readRetryAfterSeconds(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const error = (payload as { readonly error?: unknown }).error;

  if (typeof error !== "object" || error === null) {
    return null;
  }

  const retryAfterSeconds = (error as { readonly retryAfterSeconds?: unknown }).retryAfterSeconds;

  return typeof retryAfterSeconds === "number" &&
    Number.isInteger(retryAfterSeconds) &&
    retryAfterSeconds > 0 &&
    retryAfterSeconds <= 86_400
    ? retryAfterSeconds
    : null;
}

/**
 * The sentence for a refused request.
 *
 * A wait of a minute or more is rounded up to whole minutes, because "try again in 847 seconds" is a
 * number nobody converts; anything shorter stays in seconds, because "in 1 minutes" is worse than
 * "in 40 seconds".
 */
export function rateLimitSentence(payload: unknown, fallbackSeconds = 60): string {
  const seconds = readRetryAfterSeconds(payload) ?? fallbackSeconds;

  if (seconds >= 60) {
    return formatMessage("rateLimit.waitWithMinutes", { minutes: Math.ceil(seconds / 60) });
  }

  return formatMessage("rateLimit.wait", { seconds });
}

/** The sentence for a request the counter could not answer at all, which the platform refuses. */
export function rateLimitUnavailableSentence(): string {
  return getMessage("rateLimit.unavailable");
}
