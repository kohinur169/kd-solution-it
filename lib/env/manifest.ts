// path: lib/env/manifest.ts

/**
 * The environment contract of the platform.
 *
 * This file is the single source of truth for every environment variable: its name, scope,
 * format, requirement, secret flag, description and a safe placeholder. The zod schema, the
 * typed accessors in lib/env/server.ts and lib/env/client.ts, and the generated
 * .env.example all derive from this list, so a documented variable and a validated
 * variable can never be two different things.
 *
 * Values never live here. A placeholder is not a default and is never used at runtime.
 */

export const ENVIRONMENTS = ["development", "test", "production"] as const;

export type AppEnvironment = (typeof ENVIRONMENTS)[number];

export type EnvironmentScope = "server" | "client";

export type EnvironmentFormat =
  | "string"
  | "url"
  | "databaseUrl"
  | "email"
  | "enum"
  | "integer"
  | "boolean"
  | "base64Key";

export type EnvironmentRequirement = "always" | "production" | "conditional" | "optional";

export interface ConditionalRequirement {
  /** The variable whose value decides whether this variable is required. */
  readonly variable: string;
  /** The value that switches the requirement on. */
  readonly equals: string;
}

export interface EnvironmentVariableDefinition {
  readonly name: string;
  readonly scope: EnvironmentScope;
  readonly format: EnvironmentFormat;
  readonly requirement: EnvironmentRequirement;
  readonly requiredWhen?: ConditionalRequirement;
  readonly secret: boolean;
  readonly description: string;
  readonly example: string;
  readonly default?: string;
  readonly enumValues?: readonly string[];
  readonly minLength?: number;
  readonly bytes?: number;
}

const THIRTY_TWO_BYTE_PLACEHOLDER = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

export const ENVIRONMENT_VARIABLES = [
  {
    name: "NODE_ENV",
    scope: "server",
    format: "enum",
    requirement: "always",
    secret: false,
    description:
      "Runtime mode of the process. development, test or production; the hosting platform sets production.",
    example: "development",
    default: "development",
    enumValues: ["development", "test", "production"],
  },
  {
    name: "APP_URL",
    scope: "server",
    format: "url",
    requirement: "always",
    secret: false,
    description:
      "Canonical HTTPS URL of this environment. Used for absolute links in email, payment pages and tokenized client links.",
    example: "https://app.example.com",
  },
  {
    name: "DATABASE_URL",
    scope: "server",
    format: "databaseUrl",
    requirement: "always",
    secret: true,
    description:
      "PostgreSQL connection string of the Supabase project for this environment, used by migrations and server queries.",
    example: "postgresql://user:password@db.example.com:5432/postgres",
  },
  {
    name: "SUPABASE_URL",
    scope: "server",
    format: "url",
    requirement: "always",
    secret: false,
    description: "Supabase project URL of this environment.",
    example: "https://project-ref.supabase.co",
  },
  {
    name: "SUPABASE_ANON_KEY",
    scope: "server",
    format: "string",
    requirement: "always",
    secret: false,
    description:
      "Supabase anonymous key. Public by design but still only read on the server and never committed.",
    example: "replace-with-the-supabase-anonymous-key",
    minLength: 32,
  },
  {
    name: "SUPABASE_SERVICE_ROLE_KEY",
    scope: "server",
    format: "string",
    requirement: "always",
    secret: true,
    description:
      "Supabase service role key. Server only, bypasses row level security, never reachable from the browser.",
    example: "replace-with-the-supabase-service-role-key",
    minLength: 32,
  },
  {
    name: "ENCRYPTION_MASTER_KEY",
    scope: "server",
    format: "base64Key",
    requirement: "always",
    secret: true,
    description:
      "AES-256-GCM key that encrypts provider keys, email secrets and stored files. Custodian is the CEO; key material exists only here.",
    example: THIRTY_TWO_BYTE_PLACEHOLDER,
    bytes: 32,
  },
  {
    name: "AUDIT_SIGNING_KEY",
    scope: "server",
    format: "base64Key",
    requirement: "always",
    secret: true,
    description:
      "Ed25519 signing key seed for the hash-chained append-only audit log and its Merkle root export.",
    example: THIRTY_TWO_BYTE_PLACEHOLDER,
    bytes: 32,
  },
  {
    name: "STORAGE_PROVIDER",
    scope: "server",
    format: "enum",
    requirement: "optional",
    secret: false,
    description:
      "Active object storage adapter. Files are encrypted before upload either way; server local disk is never used.",
    example: "supabase",
    default: "supabase",
    enumValues: ["supabase", "s3"],
  },
  {
    name: "S3_BUCKET",
    scope: "server",
    format: "string",
    requirement: "conditional",
    requiredWhen: { variable: "STORAGE_PROVIDER", equals: "s3" },
    secret: false,
    description: "Amazon S3 bucket that holds encrypted files when the S3 adapter is active.",
    example: "kd-solution-it-files",
  },
  {
    name: "S3_REGION",
    scope: "server",
    format: "string",
    requirement: "conditional",
    requiredWhen: { variable: "STORAGE_PROVIDER", equals: "s3" },
    secret: false,
    description: "Amazon S3 region of that bucket.",
    example: "us-east-1",
  },
  {
    name: "S3_ACCESS_KEY_ID",
    scope: "server",
    format: "string",
    requirement: "conditional",
    requiredWhen: { variable: "STORAGE_PROVIDER", equals: "s3" },
    secret: true,
    description: "Access key id of the S3 user that may write and read the file bucket.",
    example: "replace-with-the-s3-access-key-id",
  },
  {
    name: "S3_SECRET_ACCESS_KEY",
    scope: "server",
    format: "string",
    requirement: "conditional",
    requiredWhen: { variable: "STORAGE_PROVIDER", equals: "s3" },
    secret: true,
    description: "Secret access key of that S3 user.",
    example: "replace-with-the-s3-secret-access-key",
  },
  {
    name: "SENTRY_DSN",
    scope: "server",
    format: "url",
    requirement: "optional",
    secret: false,
    description:
      "Sentry project DSN for server and client error reporting with release tracking. Monitoring is off while empty.",
    example: "https://public-key@o000000.ingest.sentry.io/0000000",
  },
  {
    name: "LOG_LEVEL",
    scope: "server",
    format: "enum",
    requirement: "optional",
    secret: false,
    description:
      "Minimum severity written by the structured logger: debug, info, warn or error.",
    example: "info",
    default: "info",
    enumValues: ["debug", "info", "warn", "error"],
  },
  {
    name: "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
    scope: "client",
    format: "string",
    requirement: "production",
    secret: false,
    description:
      "Cloudflare Turnstile site key for the signup, login and password reset widgets. Public by design; the secret key stays in the database settings.",
    example: "replace-with-the-turnstile-site-key",
    minLength: 10,
  },
] as const satisfies readonly EnvironmentVariableDefinition[];

export type EnvironmentVariable = (typeof ENVIRONMENT_VARIABLES)[number];

type ServerVariableDefinition = Extract<EnvironmentVariable, { scope: "server" }>;
type ClientVariableDefinition = Extract<EnvironmentVariable, { scope: "client" }>;

export type ServerEnvName = ServerVariableDefinition["name"];
export type ClientEnvName = ClientVariableDefinition["name"];

/** Variables that carry a safe default or are genuinely optional at runtime. */
type PossiblyAbsentServerEnvName = Extract<
  ServerVariableDefinition,
  { requirement: "conditional" | "optional" }
>["name"];

export type RequiredServerEnvName = Exclude<ServerEnvName, PossiblyAbsentServerEnvName>;

/**
 * A validated server environment. Required variables are strings; conditional and optional
 * ones are possibly absent, which forces the caller to handle the missing case instead of
 * receiving an empty string that looks valid.
 */
export type ServerEnvironment = Readonly<Record<RequiredServerEnvName, string>> &
  Readonly<Partial<Record<PossiblyAbsentServerEnvName, string>>>;

/** A validated client environment. Only variables safe for the browser appear here. */
export type ClientEnvironment = Readonly<Partial<Record<ClientEnvName, string>>>;

export const SERVER_VARIABLE_NAMES: readonly ServerEnvName[] = ENVIRONMENT_VARIABLES.filter(
  (definition) => definition.scope === "server",
).map((definition) => definition.name);

export const CLIENT_VARIABLE_NAMES: readonly ClientEnvName[] = ENVIRONMENT_VARIABLES.filter(
  (definition) => definition.scope === "client",
).map((definition) => definition.name);
