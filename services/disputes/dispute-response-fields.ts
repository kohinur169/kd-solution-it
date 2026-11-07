// path: services/disputes/dispute-response-fields.ts
import { z } from "zod";
import { AppError } from "../../lib/errors/app-error.ts";
import {
  DISPUTE_EXTENDED_WINDOW_HOURS,
  DISPUTE_DEFAULT_WINDOW_HOURS,
  DISPUTE_RESPONSE_MAXIMUM_LENGTH,
  DISPUTE_RESPONSE_MINIMUM_LENGTH,
  DISPUTE_RULES,
  DISPUTE_WINDOW_HOURS,
} from "./dispute-fields.ts";

/**
 * The two bodies section 19's response form sends, parsed.
 *
 * ## Why the parsers are a module of their own
 *
 * `dispute-fields.ts` is data without behaviour so that a browser component can import it without dragging
 * zod and the error catalogue along. These two parsers need both, and they are the only place in this STEP
 * where a hostile body is read: keeping them here means the service imports one function per act and cannot
 * invent a second, weaker reading of the same JSON.
 *
 * ## What a response may contain
 *
 * The merchant's own words, up to `disputes_response_check`'s twenty thousand characters. What is refused is
 * not what is *said* but what a text column should never hold: an empty save, a value past the bound, and the
 * C0 control characters that make a rendered string lie about its own length or direction. Tabs and newlines
 * stay - they are how a person writes a list of what happened - and the carriage returns a Windows paste
 * brings are folded into `\n` rather than refused, because the difference is the browser's, not the merchant's.
 *
 * HTML is not refused and not stripped: the response is stored as text and rendered as text, so `<b>` is three
 * characters a merchant may legitimately type about a product description, and escaping it at the edge would
 * corrupt the evidence rather than protect the page.
 *
 * The bidi marks (`U+202A`-`U+202E`, `U+2066`-`U+2069`) are kept for the same reason from the other direction: a
 * merchant writing in Arabic or Hebrew needs them, they are ordinary Unicode letters' company, and refusing
 * them would refuse the merchants section 19 is protecting in order to stop a display trick that the text
 * renderer already bounds.
 */

/** The control characters a text column should not hold. Tab (09) and newline (0A) are not among them. */
const controlCharacterPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

const responseBodySchema = z
  .object({
    response_text: z.string(),
  })
  .strict();

const deadlineBodySchema = z
  .object({
    response_window_hours: z.number().int(),
  })
  .strict();

/** One refusal: the field and the rule, never the value that produced it. */
function refused(field: string, rule: string, code: "VALIDATION_FAILED" | "CONFLICT" | "RESOURCE_NOT_FOUND"): AppError {
  return new AppError(code, { details: [{ field, rule }] });
}

/**
 * The response text a merchant wrote, normalised, or a refusal.
 *
 * Three normalisations and three refusals. Normalisations: CRLF becomes LF, an escaped tab stays a tab, and
 * the whole is trimmed - `disputes_response_check` requires `char_length between 1 and 20000` and
 * `0039`'s own reason column is trimmed the same way, so a save that is only spaces is not a save. Refusals:
 * empty, past the bound, or carrying a control character.
 */
export function disputeResponseTextOf(value: string): string {
  const text = value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").trim();

  if (text.length < DISPUTE_RESPONSE_MINIMUM_LENGTH) {
    throw refused("response_text", DISPUTE_RULES.responseInvalid, "VALIDATION_FAILED");
  }

  if (text.length > DISPUTE_RESPONSE_MAXIMUM_LENGTH) {
    throw refused("response_text", DISPUTE_RULES.responseInvalid, "VALIDATION_FAILED");
  }

  if (controlCharacterPattern.test(text)) {
    throw refused("response_text", DISPUTE_RULES.responseInvalid, "VALIDATION_FAILED");
  }

  return text;
}

/** What a parsed response body carries. */
export interface ParsedDisputeResponse {
  readonly responseText: string;
}

/** Parse the merchant's body. An unknown field is a refusal, never a shrug. */
export function parseDisputeResponseBody(body: unknown): ParsedDisputeResponse {
  const parsed = responseBodySchema.safeParse(body);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue?.code === "unrecognized_keys" ? issue.keys[0] : null;

    throw refused(key ?? String(issue?.path[0] ?? "response_text"), DISPUTE_RULES.responseInvalid, "VALIDATION_FAILED");
  }

  return { responseText: disputeResponseTextOf(parsed.data.response_text) };
}

/** What a parsed deadline body carries. */
export interface ParsedDisputeDeadline {
  readonly windowHours: number;
}

/**
 * Parse the super administrator's extension.
 *
 * The body names the window it wants, and only the two `disputes_window_check` allows are readable at all;
 * which of them may follow which is the service's rule (`disputeExtensionTarget`), because that depends on the
 * row rather than on the body.
 */
export function parseDisputeDeadlineBody(body: unknown): ParsedDisputeDeadline {
  const parsed = deadlineBodySchema.safeParse(body);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue?.code === "unrecognized_keys" ? issue.keys[0] : null;

    throw refused(key ?? String(issue?.path[0] ?? "response_window_hours"), DISPUTE_RULES.windowInvalid, "VALIDATION_FAILED");
  }

  const windowHours = Math.trunc(parsed.data.response_window_hours);

  if (!(DISPUTE_WINDOW_HOURS as readonly number[]).includes(windowHours)) {
    throw refused("response_window_hours", DISPUTE_RULES.windowInvalid, "VALIDATION_FAILED");
  }

  return { windowHours };
}

/** The two windows as the form offers them: the default, and the extension section 19 allows. */
export const DISPUTE_OFFERED_WINDOWS = Object.freeze([DISPUTE_DEFAULT_WINDOW_HOURS, DISPUTE_EXTENDED_WINDOW_HOURS] as const);
