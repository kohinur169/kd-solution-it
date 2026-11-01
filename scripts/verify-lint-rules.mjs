// path: scripts/verify-lint-rules.mjs
import { ESLint, Linter } from "eslint";
import nextTypeScript from "eslint-config-next/typescript";
import { fileURLToPath } from "node:url";
import process from "node:process";
import config from "../eslint.config.mjs";
import { englishOnlySource } from "./eslint-rules/english-only-source.mjs";
import { noProcessEnv } from "./eslint-rules/no-process-env.mjs";

/**
 * Lint gate. Run with `npm run check:lint`, and inside `npm run verify`.
 *
 * `npm run lint` proves that the current source satisfies the rules. It does not prove that the
 * rules exist: a rule deleted from the config, or quietly downgraded to a warning, leaves a
 * green run and no protection. This gate checks the matrix itself, then checks that the rules
 * fire on snippets that must fail, and finally asks ESLint for the resolved configuration of
 * real files to prove that the environment exemptions are exactly where they claim to be.
 *
 * No file is written: the probes are linted in memory through the `Linter` API.
 */

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const normalizedRepositoryRoot = repositoryRoot.replace(/[\\/]+$/u, "");
const failures = [];
let checkCount = 0;

function expect(condition, description) {
  checkCount += 1;

  if (!condition) {
    failures.push(description);
  }
}

function severityOf(value) {
  const primary = Array.isArray(value) ? value[0] : value;

  if (primary === "off" || primary === 0) {
    return "off";
  }
  if (primary === "warn" || primary === 1) {
    return "warn";
  }
  if (primary === "error" || primary === 2) {
    return "error";
  }

  return "unknown";
}

/** Rules that must be enforced as an error, by id. */
const requiredRules = [
  "no-console",
  "no-eval",
  "no-implied-eval",
  "no-new-func",
  "no-alert",
  "no-debugger",
  "no-var",
  "prefer-const",
  "eqeqeq",
  "local/english-only-source",
  "local/no-process-env",
  "@typescript-eslint/no-explicit-any",
  "@typescript-eslint/no-unused-vars",
  "@typescript-eslint/no-non-null-assertion",
  "@typescript-eslint/consistent-type-imports",
  "@typescript-eslint/consistent-type-assertions",
  "@typescript-eslint/no-require-imports",
  "@typescript-eslint/ban-ts-comment",
  "@typescript-eslint/no-empty-object-type",
  "@typescript-eslint/no-wrapper-object-types",
  "@typescript-eslint/no-namespace",
  "@typescript-eslint/no-unsafe-function-type",
  "@typescript-eslint/no-import-type-side-effects",
  "@typescript-eslint/no-floating-promises",
  "@typescript-eslint/no-misused-promises",
  "@typescript-eslint/await-thenable",
];

/**
 * Every severity a rule carries somewhere in the matrix. A rule may be turned off for an
 * exempt path, so the question the gate asks is whether it is an error for at least one layer.
 */
const enforcedRules = new Map();

for (const entry of config) {
  if (entry === undefined || entry.rules === undefined) {
    continue;
  }

  for (const [ruleId, value] of Object.entries(entry.rules)) {
    const severities = enforcedRules.get(ruleId) ?? new Set();

    severities.add(severityOf(value));
    enforcedRules.set(ruleId, severities);
  }
}

function checkMatrix() {
  expect(enforcedRules.size > 0, "the lint configuration must declare rules");

  for (const ruleId of requiredRules) {
    expect(enforcedRules.has(ruleId), `the matrix is missing ${ruleId}`);
    expect(
      enforcedRules.get(ruleId)?.has("error") === true,
      `${ruleId} must be an error in at least one layer, found ${
        enforcedRules.get(ruleId) === undefined
          ? "absent"
          : [...enforcedRules.get(ruleId)].join(", ")
      }`,
    );
  }

  const localPluginEntry = config.find(
    (entry) => entry !== undefined && entry.plugins !== undefined && entry.plugins.local !== undefined,
  );

  expect(localPluginEntry !== undefined, "the local rule plugin must be registered");
  expect(
    localPluginEntry !== undefined &&
      Object.hasOwn(localPluginEntry.plugins.local.rules, "english-only-source"),
    "the English-only rule must be registered in the local plugin",
  );
  expect(
    localPluginEntry !== undefined &&
      Object.hasOwn(localPluginEntry.plugins.local.rules, "no-process-env"),
    "the environment rule must be registered in the local plugin",
  );

  const typedLayer = config.find(
    (entry) =>
      entry !== undefined &&
      entry.languageOptions !== undefined &&
      entry.languageOptions.parserOptions !== undefined &&
      entry.languageOptions.parserOptions.projectService !== undefined,
  );

  expect(typedLayer !== undefined, "type aware linting must be configured with the project service");
  expect(
    typedLayer !== undefined &&
      typedLayer.languageOptions.parserOptions.tsconfigRootDir !== undefined &&
      typedLayer.languageOptions.parserOptions.tsconfigRootDir.replace(/[\\/]+$/u, "") ===
        normalizedRepositoryRoot,
    "the project service must resolve tsconfig.json from the repository root",
  );
}

const probeRules = {
  "no-console": "error",
  "no-new-func": "error",
  "no-var": "error",
  eqeqeq: "error",
  "local/english-only-source": "error",
  "local/no-process-env": "error",
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-non-null-assertion": "error",
  "@typescript-eslint/ban-ts-comment": "error",
};

const linterConfig = [
  ...nextTypeScript,
  {
    plugins: {
      local: {
        meta: { name: "kd-solution-it-local-probe", version: "1.0.0" },
        rules: {
          "english-only-source": englishOnlySource,
          "no-process-env": noProcessEnv,
        },
      },
    },
    rules: probeRules,
  },
];

const probes = [
  {
    name: "explicit any",
    ruleId: "@typescript-eslint/no-explicit-any",
    code: "// path: probe.ts\nexport const value: any = 1;\n",
  },
  {
    name: "non-null assertion",
    ruleId: "@typescript-eslint/no-non-null-assertion",
    code: "// path: probe.ts\ndeclare const maybe: string | null;\nexport const forced = maybe!;\n",
  },
  {
    name: "ts-ignore comment",
    ruleId: "@typescript-eslint/ban-ts-comment",
    code: '// path: probe.ts\n// @ts-ignore\nexport const broken: number = "text";\n',
  },
  {
    name: "console output",
    ruleId: "no-console",
    code: '// path: probe.ts\nexport function say(): void {\n  console.info("hello");\n}\n',
  },
  {
    name: "dynamic code",
    ruleId: "no-new-func",
    code: '// path: probe.ts\nexport const built = new Function("return 1");\n',
  },
  {
    name: "var declaration",
    ruleId: "no-var",
    code: "// path: probe.ts\nexport function count(): number {\n  var total = 1;\n  return total;\n}\n",
  },
  {
    name: "loose equality",
    ruleId: "eqeqeq",
    code: "// path: probe.ts\nexport function empty(value: unknown): boolean {\n  return value == null;\n}\n",
  },
  {
    name: "non English comment",
    ruleId: "local/english-only-source",
    code: "// path: probe.ts\n// \u09ac\u09be\u0982\u09b2\u09be\nexport const value = 1;\n",
  },
  {
    name: "non English string",
    ruleId: "local/english-only-source",
    code: '// path: probe.ts\nexport const greeting = "\u09a8\u09ae\u09b8\u09cd\u0995\u09be\u09b0";\n',
  },
  {
    name: "direct environment read",
    ruleId: "local/no-process-env",
    code: "// path: probe.ts\nexport const url = process.env.DATABASE_URL;\n",
  },
  {
    name: "direct environment read by index",
    ruleId: "local/no-process-env",
    code: '// path: probe.ts\nexport const stage = process["env"].NODE_ENV;\n',
  },
];

function runProbes() {
  const linter = new Linter();

  for (const probe of probes) {
    const messages = linter.verify(probe.code, linterConfig, { filename: "probe.ts" });
    const hit = messages.some((message) => message.ruleId === probe.ruleId);

    expect(hit, `the ${probe.ruleId} rule did not fire on the ${probe.name} probe`);
  }

  const cleanCode = [
    "// path: probe.ts",
    'import type { ReadonlyArray as Frozen } from "./types.ts";',
    "",
    "const label = \"A dash \u2013 a quote \u201clike this\u201d\u2026 fine\";",
    "",
    "export function add(left: number, right: number): number {",
    "  return left + right;",
    "}",
    "",
    "export function describe(values: Frozen<number>): string {",
    '  return `${label}: ${values.length}`;',
    "}",
    "",
  ].join("\n");

  const cleanMessages = linter.verify(cleanCode, linterConfig, { filename: "probe.ts" });
  expect(
    cleanMessages.length === 0,
    `the clean probe must produce no message, received: ${cleanMessages
      .map((message) => message.ruleId ?? "unknown")
      .join(", ")}`,
  );
}

async function checkResolvedConfig() {
  const eslint = new ESLint({ cwd: repositoryRoot });

  const resolvedEnvironmentOwner = await eslint.calculateConfigForFile("lib/env/server.ts");
  const resolvedModule = await eslint.calculateConfigForFile("lib/logger/logger.ts");
  const resolvedRoute = await eslint.calculateConfigForFile("app/api/health/route.ts");
  const resolvedScript = await eslint.calculateConfigForFile("scripts/verify-structure.mjs");

  expect(
    severityOf(resolvedEnvironmentOwner.rules["local/no-process-env"]) === "off",
    "lib/env/server.ts must be exempt from the environment rule, because it owns the contract",
  );
  expect(
    severityOf(resolvedScript.rules["local/no-process-env"]) === "off",
    "a Node.js script must be exempt from the environment rule",
  );
  expect(
    severityOf(resolvedModule.rules["local/no-process-env"]) === "error",
    "lib/logger/logger.ts must be governed by the environment rule",
  );
  expect(
    severityOf(resolvedRoute.rules["local/no-process-env"]) === "error",
    "a route handler must be governed by the environment rule",
  );
  expect(
    severityOf(resolvedRoute.rules["local/english-only-source"]) === "error",
    "a route handler must be governed by the English-only rule",
  );
  expect(
    severityOf(resolvedRoute.rules["@typescript-eslint/no-floating-promises"]) === "error",
    "a TypeScript file must have the promise rule enabled",
  );
  expect(
    severityOf(resolvedModule.rules["@typescript-eslint/no-explicit-any"]) === "error",
    "a TypeScript file must have the any rule enabled",
  );
}

async function main() {
  checkMatrix();
  runProbes();
  await checkResolvedConfig();

  if (failures.length > 0) {
    process.stderr.write(`lint gate failed with ${failures.length} problem(s):\n`);
    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `lint gate passed: ${checkCount} checks, ${requiredRules.length} rules enforced as errors, ` +
      `${probes.length} failure probes fired, 1 clean probe stayed clean\n`,
  );
}

await main();
