// path: lib/env/schema.ts
import { z } from "zod";
import {
  CLIENT_VARIABLE_NAMES,
  ENVIRONMENT_VARIABLES,
  ENVIRONMENTS,
  SERVER_VARIABLE_NAMES,
  type AppEnvironment,
  type ClientEnvironment,
  type ServerEnvironment,
} from "./manifest.ts";

export interface EnvironmentIssue {
  readonly variable: string;
  readonly reason: string;
}

/**
 * Raised when a variable is missing, malformed or conditionally required. The message and
 * the issues carry variable names and rules only. A value is never included, so this error
 * is safe to log and safe to surface in a boot failure.
 */
export class EnvironmentValidationError extends Error {
  readonly issues: readonly EnvironmentIssue[];

  constructor(issues: readonly EnvironmentIssue[], context: string) {
    super(
      `Environment validation failed (${context}): ${issues.length} problem(s). ` +
        issues.map((issue) => `${issue.variable} ${issue.reason}`).join("; "),
    );
    this.name = "EnvironmentValidationError";
    this.issues = issues;
  }
}

const definitionSchema = z
  .object({
    name: z.string().regex(/^[A-Z][A-Z0-9_]*$/u, {
      message: "must be an upper case environment variable name",
    }),
    scope: z.enum(["server", "client"]),
    format: z.enum([
      "string",
      "url",
      "databaseUrl",
      "email",
      "enum",
      "integer",
      "boolean",
      "base64Key",
    ]),
    requirement: z.enum(["always", "production", "conditional", "optional"]),
    requiredWhen: z
      .object({ variable: z.string().min(1), equals: z.string().min(1) })
      .optional(),
    secret: z.boolean(),
    description: z.string().min(20, {
      message: "must describe the variable well enough for .env.example",
    }),
    example: z.string().min(1),
    default: z.string().min(1).optional(),
    enumValues: z.array(z.string().min(1)).min(2).optional(),
    minLength: z.number().int().positive().optional(),
    bytes: z.number().int().positive().optional(),
  })
  .superRefine((definition, context) => {
    const carriesPublicPrefix = definition.name.startsWith("NEXT_PUBLIC_");

    if (definition.scope === "client" && !carriesPublicPrefix) {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: `client scope requires the NEXT_PUBLIC_ prefix: ${definition.name}`,
      });
    }
    if (definition.scope === "server" && carriesPublicPrefix) {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: `server scope must not use the NEXT_PUBLIC_ prefix: ${definition.name}`,
      });
    }
    if (definition.format === "enum" && definition.enumValues === undefined) {
      context.addIssue({
        code: "custom",
        path: ["enumValues"],
        message: "enum format requires enumValues",
      });
    }
    if (
      definition.enumValues !== undefined &&
      definition.default !== undefined &&
      !definition.enumValues.includes(definition.default)
    ) {
      context.addIssue({
        code: "custom",
        path: ["default"],
        message: `default must be one of ${definition.enumValues.join(", ")}`,
      });
    }
    if (definition.format === "base64Key" && definition.bytes === undefined) {
      context.addIssue({
        code: "custom",
        path: ["bytes"],
        message: "base64Key format requires the byte length",
      });
    }
    if (definition.requirement === "conditional" && definition.requiredWhen === undefined) {
      context.addIssue({
        code: "custom",
        path: ["requiredWhen"],
        message: "conditional requirement needs requiredWhen",
      });
    }
    if (definition.requirement !== "conditional" && definition.requiredWhen !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["requiredWhen"],
        message: "requiredWhen is only read when the requirement is conditional",
      });
    }
  });

/** A manifest entry after meta validation. */
export type ValidatedEnvironmentVariable = z.output<typeof definitionSchema>;

function validateManifest(): readonly ValidatedEnvironmentVariable[] {
  const definitions: ValidatedEnvironmentVariable[] = ENVIRONMENT_VARIABLES.map(
    (definition) => definitionSchema.parse(definition),
  );

  const names = new Set<string>();
  for (const definition of definitions) {
    if (names.has(definition.name)) {
      throw new Error(
        `Duplicate environment variable name in lib/env/manifest.ts: ${definition.name}`,
      );
    }
    names.add(definition.name);
  }

  for (const definition of definitions) {
    const condition = definition.requiredWhen;
    if (condition !== undefined && !names.has(condition.variable)) {
      throw new Error(
        `Conditional requirement of ${definition.name} points at an unknown variable: ${condition.variable}`,
      );
    }
  }

  return definitions;
}

/** The manifest after it has been validated against its own rules. */
export const ENVIRONMENT_DEFINITIONS = validateManifest();

const environmentSchema = z.enum(ENVIRONMENTS);

/**
 * Reads the active environment from NODE_ENV. Anything other than the three supported
 * values is rejected instead of being silently treated as development.
 */
export function resolveEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): AppEnvironment {
  const candidate = source["NODE_ENV"]?.trim();
  const value = candidate === undefined || candidate.length === 0 ? "development" : candidate;
  const parsed = environmentSchema.safeParse(value);

  if (!parsed.success) {
    throw new EnvironmentValidationError(
      [{ variable: "NODE_ENV", reason: `must be one of ${ENVIRONMENTS.join(", ")}` }],
      "NODE_ENV",
    );
  }

  return parsed.data;
}

function decodedBase64ByteLength(value: string): number | null {
  if (value.length === 0 || value.length % 4 !== 0) {
    return null;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    return null;
  }

  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function buildValueSchema(definition: ValidatedEnvironmentVariable): z.ZodType<string> {
  switch (definition.format) {
    case "url":
      return z.url({ protocol: /^https?$/u, message: "must be an absolute http or https URL" });
    case "databaseUrl":
      return z.url({
        protocol: /^postgres(ql)?$/u,
        message: "must be a PostgreSQL connection string",
      });
    case "email":
      return z.email({ message: "must be an email address" });
    case "enum": {
      // The meta schema guarantees two or more values, but the array is dynamic, so the
      // allowed set is enforced with a refinement that also produces a readable message.
      const allowedValues = definition.enumValues ?? [];
      return z
        .string()
        .refine((value) => allowedValues.includes(value), {
          message: `must be one of ${allowedValues.join(", ")}`,
        });
    }
    case "integer":
      return z
        .string()
        .refine((value) => /^-?\d+$/u.test(value), { message: "must be an integer" });
    case "boolean":
      return z.enum(["true", "false"], { message: "must be true or false" });
    case "base64Key":
      return z.string().refine(
        (value) => decodedBase64ByteLength(value) === definition.bytes,
        { message: `must be base64 that decodes to exactly ${definition.bytes ?? 0} bytes` },
      );
    case "string":
    default: {
      const minimumLength = definition.minLength ?? 1;
      return z.string().min(minimumLength, {
        message: `must be at least ${minimumLength} characters long`,
      });
    }
  }
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/**
 * Resolves one scope of the environment.
 *
 * Two passes on purpose: values and defaults are resolved first, requirements second. That
 * order lets a conditional requirement read a variable that itself came from a default,
 * such as S3_BUCKET depending on a STORAGE_PROVIDER that defaults to supabase.
 */
function parseScope(
  source: Readonly<Record<string, string | undefined>>,
  environment: AppEnvironment,
  scope: ValidatedEnvironmentVariable["scope"],
): Record<string, string> {
  const definitions = ENVIRONMENT_DEFINITIONS.filter(
    (definition) => definition.scope === scope,
  );
  const issues: EnvironmentIssue[] = [];
  const values: Record<string, string> = {};
  const rejectedVariables = new Set<string>();

  for (const definition of definitions) {
    const valueSchema = buildValueSchema(definition);
    const rawValue = source[definition.name];

    if (!isPresent(rawValue)) {
      if (definition.default !== undefined) {
        values[definition.name] = definition.default;
      }
      continue;
    }

    const parsed = valueSchema.safeParse(rawValue);
    if (!parsed.success) {
      const [firstIssue] = parsed.error.issues;
      rejectedVariables.add(definition.name);
      issues.push({
        variable: definition.name,
        reason: firstIssue?.message ?? "is not valid",
      });
      continue;
    }

    values[definition.name] = parsed.data;
  }

  for (const definition of definitions) {
    // A variable that was present but malformed has already been reported; adding "is
    // required" for the same variable would only make the boot message noisier.
    if (definition.name in values || rejectedVariables.has(definition.name)) {
      continue;
    }

    const condition = definition.requiredWhen;
    const isRequired =
      definition.requirement === "always" ||
      (definition.requirement === "production" && environment === "production") ||
      (condition !== undefined && values[condition.variable] === condition.equals);

    if (isRequired) {
      issues.push({
        variable: definition.name,
        reason:
          definition.scope === "client"
            ? `is required in ${environment} and must be present when the application is built`
            : `is required in ${environment}`,
      });
    }
  }

  if (issues.length > 0) {
    throw new EnvironmentValidationError(issues, `${scope} environment: ${environment}`);
  }

  return values;
}

export function parseServerEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  environment: AppEnvironment,
): ServerEnvironment {
  const values = parseScope(source, environment, "server");

  // parseScope has already enforced every always-required variable above, so the projection
  // cannot produce a missing required key. TypeScript cannot prove that for a dynamic record,
  // so this single assertion is the documented boundary between runtime data and the typed
  // contract exported by lib/env/manifest.ts.
  return values as ServerEnvironment;
}

export function parseClientEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  environment: AppEnvironment,
): ClientEnvironment {
  const values = parseScope(source, environment, "client");

  // Same documented boundary as above, for the public variables only.
  return values as ClientEnvironment;
}

export { CLIENT_VARIABLE_NAMES, SERVER_VARIABLE_NAMES };
