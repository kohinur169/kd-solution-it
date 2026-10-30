// path: lib/logger/levels.ts
import { getServerConfig, type LogLevel } from "../../config/server.ts";

/**
 * Severity levels understood by the structured logger.
 *
 * The list matches the values the environment contract already validates for `LOG_LEVEL`
 * (STEP 004) and that `getServerConfig()` exposes (STEP 005). A fifth level such as `fatal`
 * would have to be added there first, which is exactly the coupling this file records.
 */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type { LogLevel };

/** The level used when nothing else can be resolved, including a failed configuration read. */
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

const severityByLevel: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** True when the value is one of the four levels the platform accepts. */
export function isLogLevel(value: unknown): value is LogLevel {
  return (
    typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Reads a level from an untrusted value, or returns undefined.
 *
 * Used for an explicitly passed level (a gate, a script) and for the raw environment value
 * before the validated configuration is available. Surrounding whitespace is tolerated because
 * a value pasted into a hosting dashboard often carries it; anything else must match exactly.
 */
export function parseLogLevel(value: unknown): LogLevel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const candidate = value.trim();

  return isLogLevel(candidate) ? candidate : undefined;
}

/** True when a record at `level` must be written, given the configured minimum. */
export function isLevelEnabled(level: LogLevel, minimumLevel: LogLevel): boolean {
  return severityByLevel[level] >= severityByLevel[minimumLevel];
}

let cachedMinimumLevel: LogLevel | undefined;

/**
 * The minimum level the process writes, resolved on first use and then kept.
 *
 * Resolution goes through the validated configuration, which is the only sanctioned way server
 * code reads the environment. A configuration failure must not turn logging into a crash, so
 * the fallback is `info`: a process that is busy reporting why it is misconfigured still needs
 * to be able to write that line.
 */
export function resolveLogLevel(): LogLevel {
  cachedMinimumLevel ??= readConfiguredLevel();

  return cachedMinimumLevel;
}

function readConfiguredLevel(): LogLevel {
  try {
    return getServerConfig().logLevel;
  } catch {
    return DEFAULT_LOG_LEVEL;
  }
}
