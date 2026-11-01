// path: config/verify.ts
import process from "node:process";
import { appConfig, assertAppConfigInvariants } from "./app.ts";

/**
 * Configuration gate. Run with `npm run check:config`, and inside `npm run verify`.
 *
 * Executed directly by Node.js 26, so the gate reads the same TypeScript module the
 * application imports. It does three things:
 *
 *   1. re-runs the invariants, so an impossible combination fails even if nothing imported
 *      the configuration during this run;
 *   2. refuses a credential shaped key name, which keeps the "no secret in configuration"
 *      rule from rotting as the file grows;
 *   3. refuses a leaf that is not a string, number or boolean, so the object stays a plain
 *      frozen record of values instead of quietly holding a function or a class instance.
 */

interface ConfigLeaf {
  readonly path: string;
  readonly value: string | number | boolean;
}

const credentialShapedKeyPattern =
  /(secret|token|password|passwd|credential|private_?key|api_?key|signing_?key|access_?key)/iu;

function collectLeaves(
  value: unknown,
  path: string,
  leaves: ConfigLeaf[],
  failures: string[],
): void {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    leaves.push({ path, value });
    return;
  }

  if (Array.isArray(value) || value === null || typeof value !== "object") {
    failures.push(`${path} must be a string, number or boolean`);
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path.length === 0 ? key : `${path}.${key}`;

    if (credentialShapedKeyPattern.test(key)) {
      failures.push(
        `configuration must not expose a credential shaped key: ${childPath}. Secrets belong in lib/env/server.ts.`,
      );
    }

    collectLeaves(child, childPath, leaves, failures);
  }
}

function main(): void {
  const failures: string[] = [];
  const leaves: ConfigLeaf[] = [];

  try {
    assertAppConfigInvariants(appConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(message);
  }

  collectLeaves(appConfig, "", leaves, failures);

  if (failures.length > 0) {
    process.stderr.write(`config gate failed with ${failures.length} problem(s):\n`);
    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }
    process.exitCode = 1;
    return;
  }

  const sectionCount = Object.keys(appConfig).length;
  const moneyLeafCount = leaves.filter((leaf) => leaf.path.startsWith("money.")).length;

  process.stdout.write(
    `config gate passed: ${sectionCount} sections, ${leaves.length} values ` +
      `(${moneyLeafCount} money entries, all strings), no credential shaped key\n`,
  );
}

main();
