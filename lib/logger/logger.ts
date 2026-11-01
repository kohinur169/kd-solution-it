// path: lib/logger/logger.ts
import process from "node:process";
import { getServerConfig } from "../../config/server.ts";
import { PLATFORM_SERVICE_SLUG } from "../constants/platform.ts";
import { currentRequestContext } from "./context.ts";
import { isLevelEnabled, resolveLogLevel, type LogLevel } from "./levels.ts";
import { redactValue } from "./redact.ts";
import { serializeValue, type JsonValue } from "./serialize.ts";

/**
 * The structured logger.
 *
 * One call produces one newline terminated JSON object, which is the only shape a log
 * aggregator can parse and the only shape that keeps a request visible as a single record.
 * A record carries a fixed base (`level`, `time`, `message`, `service`, `environment`), the
 * ambient request context when there is one, the bindings inherited from a child logger, and
 * the fields of the call itself. It is then serialized with limits, redacted, and written to
 * `stdout` - or to `stderr` at `error` level, so an alert rule can watch one stream.
 *
 * Three rules this module keeps:
 *
 *   1. It never throws into the caller. A failed sink is swallowed; a broken value becomes a
 *      marker. Observability must not be able to fail a request.
 *   2. It never writes a secret. Redaction happens here, after the record is assembled, so no
 *      caller has to remember it (see `redact.ts`).
 *   3. It never writes an unbounded line. Depth, size of strings and collections, and the
 *      total record are capped (see `serialize.ts` and `MAX_RECORD_BYTES`).
 */

export type LogFields = Readonly<Record<string, unknown>>;

/** A destination for one finished line. Injected so a gate can capture both streams. */
export interface LogSink {
  write(line: string): void;
}

export interface LoggerOptions {
  /** Minimum level for this logger. Defaults to the validated `LOG_LEVEL`. */
  readonly level?: LogLevel;
  /** Fields merged into every record this logger writes. */
  readonly bindings?: LogFields;
  readonly stdout?: LogSink;
  readonly stderr?: LogSink;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds fields to every record, without losing the parent's bindings. */
  child(fields: LogFields): Logger;
}

/** Hard ceiling for one serialized record, including its newline. */
const MAX_RECORD_BYTES = 16_384;

/** A record that had to be reduced still keeps a readable, bounded message. */
const MAX_FALLBACK_MESSAGE_LENGTH = 256;

const emptyMessagePlaceholder = "(empty message)";

/** Fields a caller may not overwrite: the base record and the ambient request context. */
const reservedFieldNames: ReadonlySet<string> = new Set([
  "level",
  "time",
  "message",
  "service",
  "environment",
  "requestId",
  "method",
  "route",
  "tenantId",
  "userId",
  "ip",
]);

const REQUEST_CONTEXT_FIELD_NAMES = [
  "requestId",
  "method",
  "route",
  "tenantId",
  "userId",
  "ip",
] as const;

interface LoggerState {
  readonly level?: LogLevel;
  readonly bindings: LogFields;
  readonly stdout: LogSink;
  readonly stderr: LogSink;
}

const defaultStdoutSink: LogSink = {
  write(line: string): void {
    process.stdout.write(line);
  },
};

const defaultStderrSink: LogSink = {
  write(line: string): void {
    process.stderr.write(line);
  },
};

let cachedEnvironmentName: string | undefined;

/**
 * The environment name written on every record. A failed configuration read is reported as
 * `unknown` instead of turning a log call into an exception.
 */
function resolveEnvironmentName(): string {
  cachedEnvironmentName ??= readEnvironmentName();

  return cachedEnvironmentName;
}

function readEnvironmentName(): string {
  try {
    return getServerConfig().environment;
  } catch {
    return "unknown";
  }
}

function normalizeMessage(message: string): string {
  const trimmed = typeof message === "string" ? message.trim() : "";

  return trimmed.length === 0 ? emptyMessagePlaceholder : trimmed;
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendFields(target: Record<string, unknown>, source: LogFields | undefined): void {
  if (source === undefined) {
    return;
  }

  for (const [key, value] of Object.entries(source)) {
    if (!reservedFieldNames.has(key)) {
      target[key] = value;
    }
  }
}

function buildRecord(level: LogLevel, message: string, fields: LogFields | undefined, bindings: LogFields): Record<string, unknown> {
  const record: Record<string, unknown> = {
    level,
    time: new Date().toISOString(),
    message: normalizeMessage(message),
    service: PLATFORM_SERVICE_SLUG,
    environment: resolveEnvironmentName(),
  };

  const context = currentRequestContext();

  if (context !== undefined) {
    const contextRecord = context as unknown as Readonly<Record<string, unknown>>;

    for (const fieldName of REQUEST_CONTEXT_FIELD_NAMES) {
      const value = contextRecord[fieldName];
      if (value !== undefined) {
        record[fieldName] = value;
      }
    }
  }

  appendFields(record, bindings);
  appendFields(record, fields);

  return record;
}

/**
 * The reduced record written when the full one would exceed the byte ceiling. It keeps the
 * identifying fields, so a record that was too large can still be found and correlated.
 */
function buildFallbackRecord(level: LogLevel, message: string): Record<string, unknown> {
  const record: Record<string, unknown> = {
    level,
    time: new Date().toISOString(),
    message: normalizeMessage(message).slice(0, MAX_FALLBACK_MESSAGE_LENGTH),
    service: PLATFORM_SERVICE_SLUG,
    environment: resolveEnvironmentName(),
    truncated: true,
  };

  const context = currentRequestContext();
  if (context !== undefined) {
    record["requestId"] = context.requestId;
  }

  return record;
}

/** Serializes, flags truncation and redacts one record, then returns it as a single line. */
function renderRecord(record: Record<string, unknown>): string {
  const serialized = serializeValue(record);
  const withFlag =
    serialized.truncated && isJsonObject(serialized.value)
      ? { ...serialized.value, truncated: true }
      : serialized.value;

  return JSON.stringify(redactValue(withFlag));
}

function makeLogger(state: LoggerState): Logger {
  const write = (level: LogLevel, message: string, fields?: LogFields): void => {
    const minimumLevel = state.level ?? resolveLogLevel();

    // Filtering happens first: a suppressed record costs no serialization and no redaction.
    if (!isLevelEnabled(level, minimumLevel)) {
      return;
    }

    const sink = level === "error" ? state.stderr : state.stdout;

    try {
      const line = `${renderRecord(buildRecord(level, message, fields, state.bindings))}\n`;

      if (Buffer.byteLength(line, "utf8") <= MAX_RECORD_BYTES) {
        sink.write(line);
        return;
      }

      sink.write(`${renderRecord(buildFallbackRecord(level, message))}\n`);
    } catch {
      // A logger that throws would replace the failure it is describing. The sink is the last
      // step of the chain, so there is nothing left to report to.
    }
  };

  return {
    debug(message: string, fields?: LogFields): void {
      write("debug", message, fields);
    },
    info(message: string, fields?: LogFields): void {
      write("info", message, fields);
    },
    warn(message: string, fields?: LogFields): void {
      write("warn", message, fields);
    },
    error(message: string, fields?: LogFields): void {
      write("error", message, fields);
    },
    child(fields: LogFields): Logger {
      return makeLogger({ ...state, bindings: { ...state.bindings, ...fields } });
    },
  };
}

/**
 * Creates a logger. The application shares `logger` below; this factory exists for a child
 * logger, for a gate that injects capture sinks, and for a module that binds its own context.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const state: {
    level?: LogLevel;
    bindings: LogFields;
    stdout: LogSink;
    stderr: LogSink;
  } = {
    bindings: options.bindings ?? {},
    stdout: options.stdout ?? defaultStdoutSink,
    stderr: options.stderr ?? defaultStderrSink,
  };

  if (options.level !== undefined) {
    state.level = options.level;
  }

  return makeLogger(state);
}

/** The shared application logger. Import this instead of writing to a stream directly. */
export const logger: Logger = createLogger();
