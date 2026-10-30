// path: lib/errors/verify.ts
import process from "node:process";
import { z } from "zod";
import { getMessage } from "../i18n/messages.ts";
import { currentRequestContext, runWithRequestContext } from "../logger/context.ts";
import { createLogger } from "../logger/logger.ts";
import { AppError, isAppError, rateLimited, validationError } from "./app-error.ts";
import {
  ERROR_CODES,
  ERROR_CODE_NAMES,
  INTERNAL_ERROR_CODE,
  getErrorDefinition,
  isErrorCode,
} from "./codes.ts";
import {
  normalizeError,
  sanitizeDetails,
  toErrorResponse,
  withErrorResponse,
} from "./respond.ts";

/**
 * Error contract gate. Run with `npm run check:errors`, and inside `npm run verify`.
 *
 * It holds the response format to the rules written in `lib/errors/respond.ts`:
 *
 *   1. every code has a status, a catalog message and a retry flag, and the messages are
 *      distinct, merchant safe and free of internal vocabulary;
 *   2. an unknown failure becomes `INTERNAL_ERROR`, and its message, stack and any secret in
 *      the thrown value never reach the body or the headers;
 *   3. a validation failure lists field paths and rules, never a rejected value;
 *   4. a detail that is not a safe field path and rule name is replaced, not echoed;
 *   5. the header set is exact, and a retry delay becomes `retry-after` only for a retryable
 *      code;
 *   6. the wrapper returns a successful response untouched, catches a synchronous throw and an
 *      asynchronous rejection, opens the request context, reuses a safe inbound id, and writes
 *      exactly one log line per failure - `error` for a server fault, `warn` for a client one.
 *
 * It needs no environment and no network: every response is built in process.
 */

const failures: string[] = [];
let checkCount = 0;

function expect(condition: boolean, description: string): void {
  checkCount += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual(actual: unknown, expected: unknown, description: string): void {
  checkCount += 1;

  if (actual !== expected) {
    failures.push(
      `${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`,
    );
  }
}

interface ParsedResponse {
  readonly text: string;
  readonly body: Record<string, unknown>;
  readonly error: Record<string, unknown>;
}

async function parseResponse(response: Response): Promise<ParsedResponse> {
  const text = await response.text();
  let body: Record<string, unknown> = {};

  try {
    const parsed: unknown = JSON.parse(text);

    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    } else {
      failures.push("a response body must be a JSON object");
    }
  } catch {
    failures.push(`a response body must be valid JSON: ${text.slice(0, 120)}`);
  }

  const errorValue = body["error"];
  const error =
    typeof errorValue === "object" && errorValue !== null && !Array.isArray(errorValue)
      ? (errorValue as Record<string, unknown>)
      : {};

  return { text, body, error };
}

function checkCatalog(): void {
  const codePattern = /^[A-Z][A-Z0-9_]*$/u;
  const bannedVocabulary =
    /\b(sql|postgres|postgresql|stack|exception|trace|undefined|null|secret|token|password|credential|internal server)\b/iu;

  const messages = new Map<string, string>();

  expect(ERROR_CODE_NAMES.length >= 10, "the catalog must cover the common failure families");

  for (const code of ERROR_CODE_NAMES) {
    const definition = getErrorDefinition(code);

    expect(codePattern.test(code), `${code} must be SCREAMING_SNAKE_CASE`);
    expect(
      Number.isInteger(definition.status) && definition.status >= 400 && definition.status <= 599,
      `${code} must map to a 4xx or 5xx status`,
    );
    expect(typeof definition.retryable === "boolean", `${code} must declare retryable`);

    let message = "";
    try {
      message = getMessage(definition.messageKey);
    } catch (error) {
      failures.push(
        `${code} messageKey does not resolve: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    expect(message.trim().length > 0, `${code} must have a message`);
    expect(!message.includes("{"), `${code} message must not contain a placeholder`);
    expect(
      !bannedVocabulary.test(message),
      `${code} message must not use internal vocabulary: ${message}`,
    );

    if (messages.has(message)) {
      failures.push(`${code} and ${messages.get(message) ?? ""} share the same message`);
    } else {
      messages.set(message, code);
    }
  }

  expectEqual(ERROR_CODES.INTERNAL_ERROR.status, 500, "the internal code must be a 500");
  expect(!ERROR_CODES.INTERNAL_ERROR.retryable, "the internal code must not be retryable");
  expectEqual(
    ERROR_CODES.AUTHENTICATION_REQUIRED.status,
    401,
    "the authentication code must be a 401",
  );
  expect(
    !/account|user|email|exist/iu.test(getMessage(ERROR_CODES.AUTHENTICATION_REQUIRED.messageKey)),
    "the authentication message must not hint at whether an account exists",
  );

  expect(isErrorCode("RATE_LIMITED"), "a known code must be recognized");
  expect(!isErrorCode("NOPE"), "an unknown code must be refused");
  expect(!isErrorCode(undefined), "a non string code must be refused");
}

async function checkKnownFailures(): Promise<void> {
  const capture = createCapture();
  const log = createLogger({ level: "debug", ...capture.sinks });
  const options = { logger: log };

  await runWithRequestContext({ requestId: "req_gate_errors" }, async () => {
    const response = toErrorResponse(new AppError("RESOURCE_NOT_FOUND"), options);
    const parsed = await parseResponse(response);

    expectEqual(response.status, 404, "a known failure must use its catalog status");
    expectEqual(parsed.error["code"], "RESOURCE_NOT_FOUND", "the envelope must carry the code");
    expectEqual(
      parsed.error["message"],
      getMessage(ERROR_CODES.RESOURCE_NOT_FOUND.messageKey),
      "the envelope message must come from the catalog",
    );
    expectEqual(parsed.error["requestId"], "req_gate_errors", "the envelope must carry the request id");
    expectEqual(parsed.error["retryable"], false, "a non retryable code must say so");
    expectEqual(parsed.error["details"], undefined, "a non validation failure must carry no details");
    expectEqual(
      Object.keys(parsed.error).sort().join(","),
      "code,message,requestId,retryable",
      "the envelope must have exactly the documented fields",
    );

    const headers = response.headers;
    expectEqual(headers.get("content-type"), "application/json; charset=utf-8", "the content type must be JSON");
    expectEqual(headers.get("cache-control"), "no-store, max-age=0", "an error must never be cached");
    expectEqual(headers.get("x-content-type-options"), "nosniff", "an error must not be sniffed");
    expectEqual(headers.get("x-request-id"), "req_gate_errors", "the request id must be in a header too");

    const limited = toErrorResponse(rateLimited(30), options);
    const limitedParsed = await parseResponse(limited);
    expectEqual(limited.status, 429, "a rate limit must be a 429");
    expectEqual(limitedParsed.error["retryable"], true, "a rate limit must be retryable");
    expectEqual(limitedParsed.error["retryAfterSeconds"], 30, "a rate limit must carry the delay");
    expectEqual(limited.headers.get("retry-after"), "30", "a rate limit must set retry-after");

    const notRetryable = toErrorResponse(
      new AppError("CONFLICT", { retryAfterSeconds: 10 }),
      options,
    );
    const notRetryableParsed = await parseResponse(notRetryable);
    expectEqual(
      notRetryableParsed.error["retryAfterSeconds"],
      undefined,
      "a non retryable code must drop the delay",
    );
    expectEqual(notRetryable.headers.get("retry-after"), null, "a non retryable code must not set retry-after");

    const outOfRange = toErrorResponse(new AppError("TIMEOUT", { retryAfterSeconds: 999_999 }), options);
    const outOfRangeParsed = await parseResponse(outOfRange);
    expectEqual(
      outOfRangeParsed.error["retryAfterSeconds"],
      undefined,
      "an out of range delay must be dropped",
    );
  });
}

async function checkUnknownFailures(): Promise<void> {
  const capture = createCapture();
  const log = createLogger({ level: "debug", ...capture.sinks });
  const options = { logger: log };

  const secretUrl = "postgresql://app:sup3rs3cret@db.internal:5432/postgres";
  const secretKey = "sk_live_51ABCDEFGHIJKLMNOPQRSTUV";
  const internal = new Error(`connection failed for ${secretUrl} with ${secretKey}`);

  const thrownValues: readonly unknown[] = [
    internal,
    `crash ${secretUrl}`,
    null,
    undefined,
    { reason: secretUrl, nested: { key: secretKey } },
  ];

  for (const thrown of thrownValues) {
    const response = toErrorResponse(thrown, options);
    const parsed = await parseResponse(response);

    expectEqual(response.status, 500, "an unknown failure must be a 500");
    expectEqual(parsed.error["code"], INTERNAL_ERROR_CODE, "an unknown failure must use the internal code");
    expectEqual(
      parsed.error["message"],
      getMessage(ERROR_CODES.INTERNAL_ERROR.messageKey),
      "an unknown failure must return the catalog message",
    );
    expect(!parsed.text.includes("sup3rs3cret"), "a secret from a thrown value must not be echoed");
    expect(!parsed.text.includes(secretKey), "a key from a thrown value must not be echoed");
    expect(!parsed.text.includes(internal.message), "the raw error message must not be echoed");
    expect(!parsed.text.includes("stack"), "a stack must never be in the body");
    expect(!parsed.text.includes("at "), "a stack frame must never be in the body");
  }

  // A value that cannot be serialized must still produce an envelope.
  const circular: Record<string, unknown> = { name: "loop" };
  circular["self"] = circular;
  const circularResponse = toErrorResponse(circular, options);
  expectEqual(circularResponse.status, 500, "a circular thrown value must still produce a 500");

  // Classification is consistent and shared by every caller.
  const known = new AppError("PERMISSION_DENIED");
  expect(normalizeError(known) === known, "a known failure must pass through normalization");
  expectEqual(normalizeError(internal).code, INTERNAL_ERROR_CODE, "an error must normalize to internal");
  expect(isAppError(known), "an AppError must be recognized");
  expect(!isAppError(new Error("plain")), "a plain error is not an AppError");
  expect(!isAppError({ code: "NOPE" }), "an object with a code is not an AppError");
}

async function checkValidationFailures(): Promise<void> {
  const capture = createCapture();
  const log = createLogger({ level: "debug", ...capture.sinks });
  const options = { logger: log };

  const schema = z.object({
    email: z.email(),
    items: z.array(z.object({ price: z.number() })),
  });

  const result = schema.safeParse({ email: "not-an-email", items: [{ price: "free" }] });

  if (result.success) {
    failures.push("the validation probe must fail");
    return;
  }

  const response = toErrorResponse(result.error, options);
  const parsed = await parseResponse(response);

  expectEqual(response.status, 422, "a validation failure must be a 422");
  expectEqual(parsed.error["code"], "VALIDATION_FAILED", "a validation failure must use its code");
  expectEqual(parsed.error["retryable"], false, "a validation failure must not be retryable");

  const details = parsed.error["details"];
  expect(Array.isArray(details), "a validation failure must carry details");
  expect(Array.isArray(details) && details.length === 2, "one detail per rejected field");

  const first = Array.isArray(details) ? details[0] : undefined;
  const second = Array.isArray(details) ? details[1] : undefined;
  expectEqual(readString(first, "field"), "email", "a detail must name the field path");
  expectEqual(readString(second, "field"), "items[0].price", "a nested path must keep its index");
  expectEqual(typeof readString(second, "rule") === "string", true, "a detail must name a rule");
  expect(!parsed.text.includes("not-an-email"), "a rejected value must not be echoed");
  expect(!parsed.text.includes("free"), "a rejected nested value must not be echoed");

  // The sanitizer is what keeps a hostile detail out of a response.
  const hostile = sanitizeDetails([
    { field: "<script>alert(1)</script>", rule: "DROP TABLE users" },
    { field: "a".repeat(400), rule: "x".repeat(400) },
    { field: "items[0].email", rule: "invalid_format" },
  ]);
  expectEqual(hostile.length, 3, "every detail must survive as a value");
  expectEqual(hostile[0]?.field, "unknown", "a hostile field must be replaced");
  expectEqual(hostile[0]?.rule, "invalid", "a hostile rule must be replaced");
  expectEqual(hostile[1]?.field, "unknown", "an over long field must be replaced");
  expectEqual(hostile[1]?.rule, "invalid", "an over long rule must be replaced");
  expectEqual(hostile[2]?.field, "items[0].email", "a valid path must survive");

  const many = Array.from({ length: 40 }, (_item, index) => ({
    field: `field${index}`,
    rule: "invalid_type",
  }));
  expectEqual(sanitizeDetails(many).length, 25, "the detail list must be capped");

  const custom = toErrorResponse(validationError([{ field: "body.name", rule: "too_small" }]), options);
  const customParsed = await parseResponse(custom);
  expectEqual(custom.status, 422, "a manual validation failure must be a 422");
  expectEqual(
    Array.isArray(customParsed.error["details"]) ? customParsed.error["details"].length : 0,
    1,
    "a manual validation failure must keep its detail",
  );

  // A blank detail list is not written as an empty array.
  const empty = toErrorResponse(validationError([]), options);
  const emptyParsed = await parseResponse(empty);
  expectEqual(emptyParsed.error["details"], undefined, "an empty detail list must be omitted");
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];

  return typeof candidate === "string" ? candidate : undefined;
}

function createCapture(): {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly sinks: {
    readonly stdout: { write(line: string): void };
    readonly stderr: { write(line: string): void };
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    sinks: {
      stdout: {
        write(line: string): void {
          stdout.push(line);
        },
      },
      stderr: {
        write(line: string): void {
          stderr.push(line);
        },
      },
    },
  };
}

async function checkWrapper(): Promise<void> {
  const capture = createCapture();
  const log = createLogger({ level: "debug", ...capture.sinks });
  const options = { logger: log };

  // A successful response is returned exactly as the handler produced it.
  const successful = withErrorResponse((): Response => {
    return new Response("healthy", { status: 200, headers: { "x-handler": "kept" } });
  }, options);

  const successResponse = await successful(new Request("https://app.example.test/api/probe"));
  expectEqual(successResponse.status, 200, "a successful response must keep its status");
  expectEqual(await successResponse.text(), "healthy", "a successful response must keep its body");
  expectEqual(successResponse.headers.get("x-handler"), "kept", "a successful response must keep its headers");
  expectEqual(capture.stderr.length, 0, "a successful response must not log");
  expectEqual(capture.stdout.length, 0, "a successful response must not log");

  // A synchronous throw becomes the envelope.
  const syncThrow = withErrorResponse((): Response => {
    throw new AppError("PERMISSION_DENIED");
  }, options);

  const syncResponse = await syncThrow(new Request("https://app.example.test/api/probe"));
  const syncParsed = await parseResponse(syncResponse);
  expectEqual(syncResponse.status, 403, "a synchronous throw must become its envelope");
  expectEqual(syncParsed.error["code"], "PERMISSION_DENIED", "a synchronous throw must keep its code");

  // An asynchronous rejection becomes the envelope too.
  const asyncThrow = withErrorResponse(async (): Promise<Response> => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    throw new AppError("SERVICE_UNAVAILABLE");
  }, options);

  const asyncResponse = await asyncThrow(new Request("https://app.example.test/api/probe"));
  expectEqual(asyncResponse.status, 503, "an asynchronous rejection must become its envelope");

  // Handler arguments are forwarded.
  const withArguments = withErrorResponse(
    (request: Request, id: string): Response => new Response(`${request.method}:${id}`, { status: 200 }),
    options,
  );

  const argumentResponse = await withArguments(
    new Request("https://app.example.test/api/probe", { method: "POST" }),
    "abc",
  );
  expectEqual(await argumentResponse.text(), "POST:abc", "handler arguments must be forwarded");

  // The wrapper opens the context: a handler can log, and the envelope carries the same id.
  const contextProbe = withErrorResponse((): Response => {
    throw new AppError("TIMEOUT");
  }, options);

  const contextResponse = await contextProbe(
    new Request("https://app.example.test/api/probe", {
      method: "POST",
      headers: { "x-request-id": "proxy-0123456789" },
    }),
  );
  const contextParsed = await parseResponse(contextResponse);
  expectEqual(contextParsed.error["requestId"], "proxy-0123456789", "a safe inbound id must be reused");
  expectEqual(contextResponse.headers.get("x-request-id"), "proxy-0123456789", "the header must match the body");

  const unsafeResponse = await contextProbe(
    new Request("https://app.example.test/api/probe", {
      headers: { "x-request-id": "bad id with spaces" },
    }),
  );
  const unsafeParsed = await parseResponse(unsafeResponse);
  expectEqual(
    typeof unsafeParsed.error["requestId"] === "string" &&
      (unsafeParsed.error["requestId"] as string).startsWith("req_"),
    true,
    "an unsafe inbound id must be replaced",
  );

  // Exactly one log line per failure, on the right stream and at the right level.
  const stdoutCount = capture.stdout.length;
  const stderrCount = capture.stderr.length;
  expectEqual(stdoutCount, 1, "one client fault must be logged at warn on stdout");
  expectEqual(stderrCount, 3, "three server faults must be logged at error on stderr");

  const warnLine = capture.stdout[0] ?? "";
  const errorLine = capture.stderr[0] ?? "";
  expect(warnLine.includes('"level":"warn"'), "a client fault must be logged at warn");
  expect(warnLine.includes('"code":"PERMISSION_DENIED"'), "a warn line must carry the code");
  expect(errorLine.includes('"level":"error"'), "a server fault must be logged at error");
  expect(errorLine.includes('"code":"SERVICE_UNAVAILABLE"'), "an error line must carry the code");
  expect(errorLine.includes('"requestId"'), "an error line must carry the request id");

  // A route that never fails, and a handler that throws nothing, still gets a context.
  const contextCheck = withErrorResponse((): Response => {
    const context = currentRequestContext();

    return new Response(context === undefined ? "missing" : `${context.route}|${context.method}`, {
      status: 200,
    });
  }, options);

  const contextText = await (
    await contextCheck(new Request("https://app.example.test/api/probe", { method: "PUT" }))
  ).text();
  expectEqual(contextText, "/api/probe|PUT", "the wrapper must open a context with route and method");
}

async function main(): Promise<void> {
  checkCatalog();
  await checkKnownFailures();
  await checkUnknownFailures();
  await checkValidationFailures();
  await checkWrapper();

  if (failures.length > 0) {
    process.stderr.write(`error gate failed with ${failures.length} problem(s):\n`);
    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `error gate passed: ${checkCount} checks, ${ERROR_CODE_NAMES.length} codes, ` +
      `all statuses in 4xx or 5xx, no secret or stack in any envelope\n`,
  );
}

await main();
