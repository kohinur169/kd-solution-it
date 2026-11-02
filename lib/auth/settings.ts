// path: lib/auth/settings.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuthConfig } from "./config.ts";
import type { AuthHttp } from "./http.ts";
import { createRestClient, type RestClient } from "./rest.ts";
import { isSecretBox, openSecret } from "./secrets.ts";

/**
 * The reader of `public.platform_settings`.
 *
 * Two questions, and the split between them is the security property of the table: a value is
 * something a screen may show and a route may act on, and a secret is a credential that only the
 * code calling it ever sees. `readValue` never returns a secret row and `readSecret` never returns
 * a plain setting, so a caller cannot accidentally render a credential into a page.
 *
 * A missing key is `null` and not an error: a deployment that has not configured Turnstile yet is a
 * state the caller has to decide about, and a thrown exception would force every caller to catch
 * one. The turnstile guard of this module makes that decision in one place.
 */

/** The column list the reader selects. A narrow projection, never `select=*`. */
const settingColumns =
  "setting_key,value,is_secret,secret_iv,secret_tag,secret_ciphertext";

const settingRowSchema = z.object({
  setting_key: z.string().min(3).max(64),
  value: z.unknown(),
  is_secret: z.boolean(),
  secret_iv: z.string().nullable(),
  secret_tag: z.string().nullable(),
  secret_ciphertext: z.string().nullable(),
});

export type SettingRow = z.infer<typeof settingRowSchema>;

export interface PlatformSettings {
  /** The JSON value of a plain setting, parsed by `schema`, or null when it is not set. */
  readValue<TValue>(key: string, schema: z.ZodType<TValue>): Promise<TValue | null>;
  /** The plaintext of a secret setting, or null when it is not set. */
  readSecret(key: string): Promise<string | null>;
}

/** The additional authenticated data of a setting secret: the key it belongs to. */
export function secretContextFor(settingKey: string): string {
  return `platform_settings:${settingKey}`;
}

function queryFor(settingKey: string): string {
  return `select=${settingColumns}&setting_key=eq.${encodeURIComponent(settingKey)}&deleted_at=is.null&limit=1`;
}

async function readRow(
  rest: RestClient,
  settingKey: string,
): Promise<SettingRow | null> {
  const rows = await rest.select("platform_settings", queryFor(settingKey), settingRowSchema);

  return rows[0] ?? null;
}

export function createRestSettings(
  config: AuthConfig,
  http: AuthHttp,
  masterKey: () => string,
): PlatformSettings {
  const rest = createRestClient(config, http);

  return {
    async readValue<TValue>(
      settingKey: string,
      schema: z.ZodType<TValue>,
    ): Promise<TValue | null> {
      const row = await readRow(rest, settingKey);

      if (row === null || row.is_secret) {
        return null;
      }

      const parsed = schema.safeParse(row.value);

      if (!parsed.success) {
        throw new AppError("DEPENDENCY_FAILED");
      }

      return parsed.data;
    },

    async readSecret(settingKey: string): Promise<string | null> {
      const row = await readRow(rest, settingKey);

      if (row === null) {
        return null;
      }

      const iv = row.secret_iv;
      const tag = row.secret_tag;
      const ciphertext = row.secret_ciphertext;

      if (
        !row.is_secret ||
        iv === null ||
        tag === null ||
        ciphertext === null ||
        !isSecretBox({ iv, tag, ciphertext })
      ) {
        throw new AppError("DEPENDENCY_FAILED");
      }

      return openSecret(masterKey(), { iv, tag, ciphertext }, secretContextFor(settingKey));
    },
  };
}

/**
 * A settings source in memory, for the gate and for a deployment without a database.
 *
 * A secret is stored already opened here, because the point of this implementation is to prove the
 * caller, not the encryption; the encryption itself is proven against `secrets.ts` directly.
 */
export function createInMemorySettings(
  values: Readonly<Record<string, unknown>> = {},
  secrets: Readonly<Record<string, string>> = {},
): PlatformSettings {
  return {
    readValue<TValue>(settingKey: string, schema: z.ZodType<TValue>): Promise<TValue | null> {
      if (!Object.hasOwn(values, settingKey)) {
        return Promise.resolve(null);
      }

      const parsed = schema.safeParse(values[settingKey]);

      return parsed.success ? Promise.resolve(parsed.data) : Promise.reject(new AppError("DEPENDENCY_FAILED"));
    },

    readSecret(settingKey: string): Promise<string | null> {
      return Promise.resolve(
        Object.hasOwn(secrets, settingKey) ? (secrets[settingKey] ?? null) : null,
      );
    },
  };
}
