// path: lib/auth/rest.ts
import type { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuthConfig } from "./config.ts";
import { classifyAuthAnswer } from "./failures.ts";
import type { AuthHttp } from "./http.ts";

/**
 * The server side data access of this module: PostgREST, with the service role key.
 *
 * The platform has no database driver in its dependency tree and `package.json` is owned by the
 * integrator, so every read and write from a route handler goes through the REST surface Supabase
 * exposes in front of the database. This file is the one place that speaks it, so the two
 * properties that matter are true for every call: the key is the service role key presented only
 * from the server, and every answer is validated by a zod schema before a caller sees it.
 *
 * ## What a failure means
 *
 * PostgREST answers with a five character SQLSTATE in `code`. That difference decides the answer a
 * caller gets, and the three cases are deliberately distinct:
 *
 *   - a unique violation (`23505`) is a conflict the routing layer must resolve or report;
 *   - any other integrity violation (SQLSTATE class `23`, or an HTTP 400 or 422) is invalid input
 *     for this table;
 *   - anything else - a `401`, a `404`, a `5xx`, a socket failure - is the deployment, not the
 *     caller, and becomes `DEPENDENCY_FAILED` so an outage is never reported as a bad form.
 */

/** SQLSTATE of a unique violation. PostgREST returns it verbatim in `code`. */
export const UNIQUE_VIOLATION = "23505";

function tableUrl(config: AuthConfig, table: string): string {
  return `${config.projectUrl}/rest/v1/${table}`;
}

function rpcUrl(config: AuthConfig, functionName: string): string {
  return `${config.projectUrl}/rest/v1/rpc/${functionName}`;
}

function throwRestFailure(code: string | null, status: number | null): never {
  if (status === 409 || code === UNIQUE_VIOLATION) {
    throw new AppError("CONFLICT");
  }

  const isIntegrityViolation =
    (code !== null && code.startsWith("23")) || status === 400 || status === 422;

  if (isIntegrityViolation) {
    throw new AppError("VALIDATION_FAILED");
  }

  throw new AppError("DEPENDENCY_FAILED");
}

export interface RestClient {
  /** Read rows of one table through a PostgREST query string, validated by `schema`. */
  select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]>;
  /** Insert rows without reading them back. */
  insert(table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void>;
  /** Insert rows and read the representation back, which is what a generated column needs. */
  insertReturning<TRow>(
    table: string,
    rows: readonly Readonly<Record<string, unknown>>[],
    schema: z.ZodType<TRow>,
  ): Promise<readonly TRow[]>;
  /** Update the rows a query selects, and read nothing back. */
  update(
    table: string,
    query: string,
    values: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  /** Call a stored function and return its raw body. A scalar function answers with a scalar. */
  rpc(functionName: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/**
 * The errors an insert can raise, in the vocabulary of this module.
 *
 * Exported so a caller can recognise a conflict without parsing a SQLSTATE itself; the signup of
 * STEP 038 uses it to retry a company slug once and to answer an existing address generically.
 */
export function isConflictError(error: unknown): boolean {
  return error instanceof AppError && error.code === "CONFLICT";
}

export function createRestClient(config: AuthConfig, http: AuthHttp): RestClient {
  async function send(
    method: "GET" | "POST" | "PATCH",
    url: string,
    options: {
      readonly body?: unknown;
      readonly prefer?: string;
    },
  ): Promise<unknown> {
    const answer = await http.send({
      method,
      url,
      apiKey: config.serviceRoleKey,
      bearerToken: config.serviceRoleKey,
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.prefer === undefined ? {} : { headers: { prefer: options.prefer } }),
    });

    if (!answer.ok) {
      throwRestFailure(answer.failure.code, answer.failure.status);
    }

    const failure = classifyAuthAnswer(answer.value);

    if (failure !== null) {
      throwRestFailure(failure.code, failure.status);
    }

    return answer.value.body;
  }

  return {
    async select<TRow>(
      table: string,
      query: string,
      schema: z.ZodType<TRow>,
    ): Promise<readonly TRow[]> {
      const body = await send("GET", `${tableUrl(config, table)}?${query}`, {});
      const parsed = schema.array().safeParse(body);

      if (!parsed.success) {
        throw new AppError("DEPENDENCY_FAILED");
      }

      return parsed.data;
    },

    async insert(
      table: string,
      rows: readonly Readonly<Record<string, unknown>>[],
    ): Promise<void> {
      await send("POST", tableUrl(config, table), {
        body: rows,
        prefer: "return=minimal",
      });
    },

    async insertReturning<TRow>(
      table: string,
      rows: readonly Readonly<Record<string, unknown>>[],
      schema: z.ZodType<TRow>,
    ): Promise<readonly TRow[]> {
      const body = await send("POST", tableUrl(config, table), {
        body: rows,
        prefer: "return=representation",
      });
      const parsed = schema.array().safeParse(body);

      if (!parsed.success) {
        throw new AppError("DEPENDENCY_FAILED");
      }

      return parsed.data;
    },

    async update(
      table: string,
      query: string,
      values: Readonly<Record<string, unknown>>,
    ): Promise<void> {
      await send("PATCH", `${tableUrl(config, table)}?${query}`, {
        body: values,
        prefer: "return=minimal",
      });
    },

    rpc(
      functionName: string,
      arguments_: Readonly<Record<string, unknown>>,
    ): Promise<unknown> {
      return send("POST", rpcUrl(config, functionName), { body: arguments_ });
    },
  };
}
