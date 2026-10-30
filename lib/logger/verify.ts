// path: lib/logger/verify.ts
import process from "node:process";
import { PLATFORM_SERVICE_SLUG } from "../constants/platform.ts";
import {
  createRequestId,
  currentRequestContext,
  isSafeRequestId,
  resolveRequestId,
  runWithRequestContext,
} from "./context.ts";
import { isLevelEnabled, LOG_LEVELS, parseLogLevel, resolveLogLevel } from "./levels.ts";
import { createLogger, type LogSink } from "./logger.ts";
import { REDACTED_MARKER, isSensitiveFieldName, redactText } from "./redact.ts";
import { serializeValue, type JsonValue } from "./serialize.ts";

/**
 * Logger gate. Run with `npm run check:logger`, and inside `npm run verify`.
 *
 * It executes the logger the way a request does - through the ambient context, into capture
 * sinks - and then reads the produced lines back. A logger is only trustworthy if its output
 * is, so every rule below is checked against the bytes that would reach a log aggregator:
 *
 *   1. levels filter, and `error` goes to `stderr` while the rest goes to `stdout`;
 *   2. every line is one JSON object, with a parseable time and the platform service name;
 *   3. a request id is present, stable across `await` and timers, inherited by a nested call,
 *      and never taken from an unsafe header;
 *   4. no secret survives redaction, whether it arrived in a named field or inside free text;
 *   5. a pathological value - circular, huge, deep - becomes a bounded, valid record;
 *   6. a caller cannot overwrite the base fields, and a failing sink cannot throw.
 *
 * It needs no environment: the logger falls back to `info` when the configuration cannot be
 * read, which is also checked here.
 */

const failures: string[] = [];
let checkCount = 0;
let recordCount = 0;

interface Capture {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly sinks: { readonly stdout: LogSink; readonly stderr: LogSink };
}

function createCapture(): Capture {
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

function expect(condition: boolean, description: string): void {
  checkCount += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual(actual: unknown, expected: unknown, description: string): void {
  checkCount += 1;

  if (actual !== expected) {
    failures.push(`${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`);
  }
}

function expectJson(actual: unknown, expected: unknown, description: string): void {
  checkCount += 1;

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(
      `${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`,
    );
  }
}

/** A record at an index, or null, so the checks below need no undefined handling. */
function recordAt(records: readonly Record<string, JsonValue>[], index: number): JsonValue {
  return records[index] ?? null;
}

function readPath(value: JsonValue | undefined, path: string): JsonValue | undefined {
  let current = value;

  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }

    current = (current as { readonly [key: string]: JsonValue })[segment];
  }

  return current;
}

/** Parses captured lines, recording a failure for anything that is not one JSON object. */
function parseLines(lines: readonly string[], label: string): Record<string, JsonValue>[] {
  const records: Record<string, JsonValue>[] = [];

  for (const line of lines) {
    recordCount += 1;
    expect(line.endsWith("\n"), `${label}: a line must end with one newline`);
    expect(
      (line.match(/\n/gu) ?? []).length === 1,
      `${label}: a record must be one physical line`,
    );

    try {
      const parsed: unknown = JSON.parse(line);

      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, JsonValue>);
      } else {
        failures.push(`${label}: a record must be a JSON object`);
      }
    } catch {
      failures.push(`${label}: a line is not valid JSON: ${line.slice(0, 120)}`);
    }
  }

  return records;
}

// Secrets used only by this gate. Every one of them must be absent from the output.
const secrets = {
  password: "hunter2-correct-horse-battery",
  bearer: "Bearer abcdefghijklmnopqrstuvwxyz012345",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  providerKey: "sk_live_51ABCDEFGHIJKLMNOPQRSTUV",
  webhookSecret: "whsec_abcdefghijklmnop1234",
  awsKeyId: "AKIAIOSFODNN7EXAMPLE",
  databaseUrl: "postgresql://app:sup3rs3cret@db.internal:5432/postgres",
  privateKeyBody: "MIIEowIBAAKCAQEAfakekeymaterial",
  privateKey:
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfakekeymaterial\n-----END RSA PRIVATE KEY-----",
  queryString: "password=letmein-please",
} as const;

const leakedFragments = [
  secrets.password,
  "abcdefghijklmnopqrstuvwxyz012345",
  "eyJhbGciOiJIUzI1NiJ9",
  "sk_live_51ABCDEFGHIJKLMNOPQRSTUV",
  "whsec_abcdefghijklmnop1234",
  secrets.awsKeyId,
  "sup3rs3cret",
  secrets.privateKeyBody,
  "letmein-please",
] as const;

function checkLevels(): void {
  expectEqual(LOG_LEVELS.length, 4, "four levels must be declared");
  expect(!isLevelEnabled("debug", "warn"), "debug must be suppressed at warn");
  expect(!isLevelEnabled("info", "warn"), "info must be suppressed at warn");
  expect(isLevelEnabled("warn", "warn"), "warn must be written at warn");
  expect(isLevelEnabled("error", "debug"), "error must be written at debug");
  expectEqual(parseLogLevel(" warn "), "warn", "a padded level must be accepted");
  expectEqual(parseLogLevel("verbose"), undefined, "an unknown level must be refused");
  expectEqual(parseLogLevel(42), undefined, "a non string level must be refused");
  expect(
    (LOG_LEVELS as readonly string[]).includes(resolveLogLevel()),
    "the resolved level must be one of the declared levels even without a validated environment",
  );
}

function checkFilteringAndShape(): void {
  const capture = createCapture();
  const log = createLogger({ level: "warn", ...capture.sinks });

  log.debug("debug line", { step: 1 });
  log.info("info line", { step: 2 });
  log.warn("warn line", { step: 3 });
  log.error("error line", { step: 4 });

  expectEqual(capture.stdout.length, 1, "only the warn line must reach stdout at warn");
  expectEqual(capture.stderr.length, 1, "only the error line must reach stderr");

  const stdoutRecords = parseLines(capture.stdout, "stdout");
  const stderrRecords = parseLines(capture.stderr, "stderr");

  const warnRecord = stdoutRecords[0];
  const errorRecord = stderrRecords[0];

  expectEqual(warnRecord?.["level"], "warn", "the level field must match the call");
  expectEqual(warnRecord?.["message"], "warn line", "the message field must match the call");
  expectEqual(warnRecord?.["service"], PLATFORM_SERVICE_SLUG, "the service field must be the platform slug");
  expect(typeof warnRecord?.["time"] === "string", "a record must carry a time field");
  expect(
    typeof warnRecord?.["time"] === "string" &&
      !Number.isNaN(Date.parse(warnRecord["time"] as string)),
    "the time field must be a parseable ISO timestamp",
  );
  expect(warnRecord?.["environment"] !== undefined, "a record must carry an environment field");
  expectEqual(warnRecord?.["step"], 3, "call fields must be written");
  expectEqual(warnRecord?.["truncated"], undefined, "a small record must not be flagged truncated");
  expectEqual(errorRecord?.["level"], "error", "the error level must be written");

  // The base fields are the logger's, not the caller's.
  const spoofCapture = createCapture();
  const spoofLog = createLogger({ level: "debug", ...spoofCapture.sinks });
  spoofLog.info("spoof attempt", { level: "error", time: "not a time", service: "evil", message: "evil" });
  const spoofRecord = parseLines(spoofCapture.stdout, "stdout")[0];
  expectEqual(spoofRecord?.["level"], "info", "a caller must not overwrite the level field");
  expectEqual(spoofRecord?.["service"], PLATFORM_SERVICE_SLUG, "a caller must not overwrite the service field");
  expectEqual(spoofRecord?.["message"], "spoof attempt", "a caller must not overwrite the message field");
  expect(spoofRecord?.["time"] !== "not a time", "a caller must not overwrite the time field");

  // An empty message is replaced rather than written as a blank field.
  const emptyCapture = createCapture();
  createLogger({ level: "info", ...emptyCapture.sinks }).info("   ");
  const emptyRecord = parseLines(emptyCapture.stdout, "stdout")[0];
  expectEqual(emptyRecord?.["message"], "(empty message)", "an empty message must be marked");

  // A sink that throws must not propagate into the caller.
  const throwingLog = createLogger({
    level: "info",
    stdout: {
      write(): void {
        throw new Error("sink is gone");
      },
    },
  });
  let threw = false;
  try {
    throwingLog.info("sink failure");
  } catch {
    threw = true;
  }
  expect(!threw, "a failing sink must not throw into the caller");
}

async function checkRequestContext(): Promise<void> {
  const generated = createRequestId();
  expect(isSafeRequestId(generated), "a generated request id must pass the safe alphabet");
  expect(generated.startsWith("req_"), "a generated request id must be prefixed");
  expect(!isSafeRequestId("bad id with spaces"), "a header value with spaces must be refused");
  expect(!isSafeRequestId("line\nbreak"), "a header value with a newline must be refused");
  expect(isSafeRequestId(resolveRequestId("bad id")), "an unsafe id must be replaced by a safe one");
  expect(isSafeRequestId(resolveRequestId("proxy-0123456789")), "a replacement must be safe");
  expectEqual(resolveRequestId("proxy-0123456789"), "proxy-0123456789", "a safe header value must be kept");

  const capture = createCapture();
  const log = createLogger({ level: "debug", ...capture.sinks });
  const route = "/api/health";

  const outerId = runWithRequestContext({ requestId: "req_gate_outer", method: "GET", route }, () => {
    const inside = currentRequestContext();
    expectEqual(inside?.requestId, "req_gate_outer", "the context must expose the request id");
    expectEqual(inside?.route, route, "the context must expose the route");

    log.info("before await");

    return inside?.requestId ?? "";
  });

  await runWithRequestContext({ requestId: outerId, method: "GET", route }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    log.info("after await");
    log.warn("after await, warn");

    // A nested scope without an id inherits the outer one.
    await runWithRequestContext({}, async () => {
      log.debug("nested scope");
    });

    // A nested scope with an id takes the new one.
    await runWithRequestContext({ requestId: "req_gate_inner" }, async () => {
      log.info("nested with id");
    });
  });

  const records = parseLines(capture.stdout, "stdout");
  const outerLines = records.filter((record) => record["requestId"] === "req_gate_outer");
  const innerLines = records.filter((record) => record["requestId"] === "req_gate_inner");

  expectEqual(outerLines.length, 4, "four lines must carry the outer request id");
  expectEqual(innerLines.length, 1, "one line must carry the nested request id");
  expect(
    outerLines.every((record) => record["route"] === route),
    "every line in the request must carry the route",
  );

  // Outside a request there is no request id at all.
  const outsideCapture = createCapture();
  createLogger({ level: "info", ...outsideCapture.sinks }).info("outside");
  const outsideRecord = parseLines(outsideCapture.stdout, "stdout")[0];
  expectEqual(outsideRecord?.["requestId"], undefined, "a line outside a request must have no request id");

  // A caller cannot spoof the context fields through the payload.
  const spoofCapture = createCapture();
  runWithRequestContext({ requestId: "req_gate_real" }, () => {
    createLogger({ level: "info", ...spoofCapture.sinks }).info("spoof", { requestId: "req_fake" });
  });
  const spoofRecord = parseLines(spoofCapture.stdout, "stdout")[0];
  expectEqual(spoofRecord?.["requestId"], "req_gate_real", "a payload must not overwrite the request id");
}

function checkRedaction(): void {
  expect(isSensitiveFieldName("API_KEY"), "a normalized secret field name must be detected");
  expect(isSensitiveFieldName("service_role_key"), "a service role key field must be detected");
  expect(isSensitiveFieldName("Authorization"), "an authorization field must be detected");
  expect(!isSensitiveFieldName("userId"), "an identifier field must not be treated as a secret");
  expect(!isSensitiveFieldName("amount"), "an amount field must not be treated as a secret");

  expectEqual(
    redactText("payment of 100.0000 USD for tenant_1"),
    "payment of 100.0000 USD for tenant_1",
    "ordinary text must pass through untouched",
  );

  const capture = createCapture();
  const log = createLogger({ level: "debug", ...capture.sinks });

  log.info("named secret fields", {
    password: secrets.password,
    token: "opaque-token-value",
    authorization: secrets.bearer,
    cookie: "session=abc",
    api_key: "opaque-api-key",
    serviceRoleKey: "opaque-service-role-key",
    cardNumber: "4242424242424242",
    cvv: 737,
    privateKey: secrets.privateKey,
    credentials: { user: "app", secret: "opaque" },
    key: "opaque-key",
    dsn: "opaque-dsn",
  });

  log.info("secrets in free text", {
    message1: secrets.bearer,
    message2: secrets.jwt,
    message3: secrets.providerKey,
    message4: secrets.webhookSecret,
    message5: secrets.awsKeyId,
    message6: secrets.databaseUrl,
    message7: secrets.queryString,
    message8: secrets.privateKey,
  });

  log.info("nested secret", { outer: { middle: { token: "deep-token-value" } } });

  const records = parseLines(capture.stdout, "stdout");
  const named = readPath(recordAt(records, 0), "password");
  expectEqual(named, REDACTED_MARKER, "a password field must be replaced by the marker");
  expectEqual(readPath(recordAt(records, 0), "cvv"), REDACTED_MARKER, "a numeric cvv must be replaced by the marker");
  expectEqual(
    readPath(recordAt(records, 0), "credentials"),
    REDACTED_MARKER,
    "a credentials object must be replaced by the marker",
  );
  expectEqual(
    readPath(recordAt(records, 2), "outer.middle.token"),
    REDACTED_MARKER,
    "a nested secret field must be replaced by the marker",
  );

  const serializedOutput = [...capture.stdout, ...capture.stderr].join("");
  for (const fragment of leakedFragments) {
    expect(!serializedOutput.includes(fragment), `a secret fragment survived redaction: ${fragment.slice(0, 24)}`);
  }

  // A masked value keeps the shape of the surrounding text so a reader can still follow it.
  expect(
    serializedOutput.includes(`Bearer ${REDACTED_MARKER}`),
    "a bearer token must be masked in place",
  );
  expect(
    serializedOutput.includes(`postgresql://app:${REDACTED_MARKER}@db.internal`),
    "a connection string must keep its host and mask its password",
  );
  expect(
    serializedOutput.includes(`${REDACTED_MARKER}`),
    "the marker must appear in the output",
  );
}

function checkSerialization(): void {
  const circular: Record<string, unknown> = { name: "loop" };
  circular["self"] = circular;
  const circularResult = serializeValue(circular);
  expectEqual(readPath(circularResult.value, "self"), "[circular]", "a circular reference must be marked");
  expect(circularResult.truncated, "a circular reference must flag the record as truncated");

  const error = new Error("charge failed", { cause: new Error("card declined") });
  const errorResult = serializeValue({ error });
  expectEqual(readPath(errorResult.value, "error.name"), "Error", "an error must keep its name");
  expectEqual(readPath(errorResult.value, "error.message"), "charge failed", "an error must keep its message");
  expect(typeof readPath(errorResult.value, "error.stack") === "string", "an error must keep its stack");
  expectEqual(
    readPath(errorResult.value, "error.cause.message"),
    "card declined",
    "an error cause must be kept",
  );

  expectEqual(serializeValue(10n).value, "10n", "a bigint must become a string");
  expectEqual(serializeValue(new Date("2026-01-02T03:04:05.000Z")).value, "2026-01-02T03:04:05.000Z", "a date must become ISO text");
  expectEqual(serializeValue(Number.NaN).value, "NaN", "NaN must become a readable marker");
  expectEqual(serializeValue(Number.POSITIVE_INFINITY).value, "Infinity", "Infinity must become a readable marker");
  expectEqual(readPath(serializeValue({ missing: undefined }).value, "missing"), undefined, "an undefined field must be omitted");
  expectJson(serializeValue([undefined]).value, [null], "an undefined array item must become null");
  expectEqual(serializeValue(() => 1).value, "[function]", "a function must be marked");
  expectJson(serializeValue(new Set([1, 2])).value, [1, 2], "a set must become an array");
  expectEqual(readPath(serializeValue(new Map([["a", 1]])).value, "a"), 1, "a map must become an object");

  const deep = serializeValue({ a: { b: { c: 1 } } }, { maxDepth: 2, maxArrayItems: 10, maxObjectKeys: 10, maxStringLength: 10 });
  expectEqual(readPath(deep.value, "a.b"), "[depth limit]", "a value beyond the depth limit must be marked");

  const longArray = serializeValue(Array.from({ length: 60 }, (_item, index) => index));
  const arrayValue = longArray.value;
  expect(Array.isArray(arrayValue) && arrayValue.length === 51, "an array must be capped at the limit plus one marker");
  expect(
    Array.isArray(arrayValue) && arrayValue[50] === "[10 more items]",
    "a capped array must report how many items were dropped",
  );

  const longString = serializeValue("x".repeat(3000));
  expect(
    typeof longString.value === "string" && longString.value.endsWith("…[+1000 chars]"),
    "a long string must be truncated with a count",
  );
  expect(longString.truncated, "a truncated string must flag the record as truncated");
}

function checkSizeGuard(): void {
  const capture = createCapture();
  const log = createLogger({ level: "info", ...capture.sinks });

  // Each string is inside the per-value limit, so only the whole record ceiling can stop this:
  // fifty arrays of fifty 2000 character strings is roughly five megabytes of JSON.
  const bulk = Array.from({ length: 50 }, () =>
    Array.from({ length: 50 }, () => "A".repeat(2000)),
  );

  log.info("oversized payload", { blob: bulk });

  const line = capture.stdout[0];
  expect(line !== undefined, "an oversized record must still be written");
  expect(
    line !== undefined && Buffer.byteLength(line, "utf8") <= 16_384,
    "an oversized record must respect the byte ceiling",
  );

  const record = parseLines(capture.stdout, "stdout")[0];
  expectEqual(record?.["level"], "info", "a reduced record must keep its level");
  expectEqual(record?.["message"], "oversized payload", "a reduced record must keep its message");
  expectEqual(record?.["truncated"], true, "a reduced record must say it was truncated");
}

async function main(): Promise<void> {
  checkLevels();
  checkFilteringAndShape();
  await checkRequestContext();
  checkRedaction();
  checkSerialization();
  checkSizeGuard();

  if (failures.length > 0) {
    process.stderr.write(`logger gate failed with ${failures.length} problem(s):\n`);
    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `logger gate passed: ${checkCount} checks, ${recordCount} records parsed, ` +
      `${LOG_LEVELS.length} levels, ${leakedFragments.length} secret fragments absent\n`,
  );
}

await main();
