// path: lib/auth/breach-check.ts
import { createHash } from "node:crypto";
import { z } from "zod";
import { classifyAuthAnswer } from "./failures.ts";
import type { AuthHttp } from "./http.ts";
import type { PlatformSettings } from "./settings.ts";
import type { AuthFailure, AuthOutcome } from "./types.ts";

/**
 * The breached password check of section 22, without sending a password anywhere.
 *
 * ## k-anonymity, in one paragraph
 *
 * The password is hashed with SHA-1, which is what the published corpus is indexed by. Only the
 * first five hexadecimal characters of that hash leave the process; the service answers every
 * suffix that shares them - roughly a thousand hashes - and the comparison happens here. The
 * password, the full hash and the address of the person choosing it are never transmitted, which is
 * why the range query is allowed at all. `add-padding` is sent so the answer has a constant size
 * and an observer cannot count how many suffixes came back.
 *
 * ## What the platform accepts from it
 *
 * Three verdicts and no others. `clear` means the suffix was absent from the range or present with
 * the zero count the padding uses. `breached` means a real count. `skipped` means the check is off,
 * which outside production is a developer's choice and inside production is a refusal: `0081`
 * seeds the switch open, so a closed one is deliberate. The verdict is written into the signup's
 * audit payload either way, so a database can answer "was this password checked" without trusting
 * a log line.
 *
 * ## Cost and failure
 *
 * A range answer is a few hundred kilobytes of plain text, far above the identity provider ceiling,
 * so the caller passes a transport built for this endpoint. A provider that cannot answer is a
 * `DEPENDENCY_FAILED`; the platform refuses the signup rather than accepting a password it could
 * not check, because accepting one would make the check advisory, and an advisory security control
 * is worse than none: it is a control someone believes in.
 */

export const BREACH_CHECK_ENABLED_SETTING = "password.breach_check.enabled";

/** The range endpoint. A suffix is appended to it, never a password. */
export const BREACH_RANGE_ENDPOINT = "https://api.pwnedpasswords.com/range/";

/** The largest range answer this build will read. The padded answer is about one megabyte. */
export const BREACH_RANGE_MAXIMUM_BYTES = 4 * 1024 * 1024;

/** The number of suffix lines a range answer may carry before it is called malformed. */
const maximumRangeLines = 200_000;

const enabledSchema = z.boolean();

/** `breached` when the corpus knows the password, `clear` when it does not, `skipped` when off. */
export type BreachVerdict = "clear" | "breached" | "skipped";

export interface BreachCheck {
  check(password: string): Promise<AuthOutcome<BreachVerdict>>;
}

export interface BreachCheckOptions {
  readonly settings: PlatformSettings;
  readonly http: AuthHttp;
  /** True in production, where the switch is an operator decision rather than a default. */
  readonly isProduction: boolean;
  /** The range endpoint. Overridden by the gate so no proof needs a network. */
  readonly endpoint?: string;
}

function failureOf(
  kind: AuthFailure["kind"],
  status: number | null = null,
  code: string | null = null,
): AuthFailure {
  return { kind, status, code, retryAfterSeconds: null };
}

/**
 * The two halves of the SHA-1 of a password, upper case, as the corpus indexes them.
 *
 * SHA-1 is not a security boundary here and is not used to store anything: it is the index the
 * published corpus already has, and refusing to use it would mean sending a password instead.
 */
export function breachHashParts(password: string): { readonly prefix: string; readonly suffix: string } {
  const digest = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();

  return { prefix: digest.slice(0, 5), suffix: digest.slice(5) };
}

const suffixLinePattern = /^([0-9A-F]{35}):([0-9]{1,10})$/u;

/**
 * Read a range answer.
 *
 * `null` means the answer was not a range at all, which is a provider fault and not a verdict. An
 * empty answer is legal and means `clear`: the range exists even when it carries no suffix.
 */
export function readBreachRange(answer: string, suffix: string): BreachVerdict | null {
  const lines = answer.split(/\r?\n/u);

  if (lines.length > maximumRangeLines) {
    return null;
  }

  const wanted = suffix.toUpperCase();

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.length === 0) {
      continue;
    }

    const match = suffixLinePattern.exec(line);

    if (match === null) {
      return null;
    }

    const [, lineSuffix, countText] = match;

    if (lineSuffix === wanted && countText !== undefined && Number.parseInt(countText, 10) > 0) {
      return "breached";
    }
  }

  // A blank line is skipped and an unparseable one returned null above, so a body that reaches this
  // point carried nothing but blank lines: an empty range, which is clear.
  return "clear";
}

export function createBreachCheck(options: BreachCheckOptions): BreachCheck {
  const endpoint = options.endpoint ?? BREACH_RANGE_ENDPOINT;

  return {
    async check(password: string): Promise<AuthOutcome<BreachVerdict>> {
      const enabled = await options.settings.readValue(BREACH_CHECK_ENABLED_SETTING, enabledSchema);

      if (enabled !== true) {
        // The switch is seeded open by `0081`, so a closed one is a deliberate act. In production
        // that act is refused rather than obeyed: a signup that claims to have checked a password
        // and did not is worse than a signup that fails and says so.
        return options.isProduction
          ? { ok: false, failure: failureOf("upstream") }
          : { ok: true, value: "skipped" };
      }

      const { prefix, suffix } = breachHashParts(password);
      const answer = await options.http.send({
        method: "GET",
        url: `${endpoint}${prefix}`,
        // The corpus takes no key of any kind; the platform presents none.
        apiKey: "",
        headers: { "add-padding": "true" },
        responseFormat: "text",
      });

      if (!answer.ok) {
        return { ok: false, failure: answer.failure };
      }

      const httpFailure = classifyAuthAnswer(answer.value);

      if (httpFailure !== null) {
        return { ok: false, failure: httpFailure };
      }

      if (typeof answer.value.body !== "string") {
        return { ok: false, failure: failureOf("malformed-response", answer.value.status) };
      }

      const verdict = readBreachRange(answer.value.body, suffix);

      if (verdict === null) {
        return { ok: false, failure: failureOf("malformed-response", answer.value.status) };
      }

      return { ok: true, value: verdict };
    },
  };
}

/** The check of a deployment with no corpus to reach, for the gate and for a dry run. */
export function createFixedBreachCheck(verdict: BreachVerdict): BreachCheck {
  return {
    check: (): Promise<AuthOutcome<BreachVerdict>> => Promise.resolve({ ok: true, value: verdict }),
  };
}
