// path: eslint.config.mjs
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";
import { englishOnlySource } from "./scripts/eslint-rules/english-only-source.mjs";
import { noProcessEnv } from "./scripts/eslint-rules/no-process-env.mjs";

/**
 * The lint matrix.
 *
 * Rules are grouped by intent so that a reader can tell why a rule exists:
 *
 *   1. Next.js and React rules, from eslint-config-next.
 *   2. TypeScript parsing and its recommended rules, from eslint-config-next/typescript. Those
 *      are already a declared dependency, so the parser and the plugin cost nothing extra.
 *   3. Platform safety: no output bypassing the logger, no dynamic code, no loose equality, no
 *      `var`.
 *   4. Strict typing: no escape hatch that an annotation, an assertion or a comment can open,
 *      plus the promise rules that need type information.
 *   5. Platform boundaries: English only source, and the environment read only through
 *      lib/env/.
 *
 * Every entry is an error. A warning in a gate is a rule that is already being ignored, and
 * `npm run check:lint` refuses a matrix entry that is not set to error.
 */

const localPlugin = {
  meta: { name: "kd-solution-it-local", version: "1.0.0" },
  rules: {
    "english-only-source": englishOnlySource,
    "no-process-env": noProcessEnv,
  },
};

const codeFiles = ["**/*.{js,jsx,mjs,cjs,ts,tsx}"];
const typeScriptFiles = ["**/*.{ts,tsx}"];

/**
 * Files that own the environment contract. Every other file reads configuration through
 * lib/env/ or config/, and a raw read there is a lint failure.
 */
const environmentOwners = [
  "lib/env/**",
  "instrumentation.ts",
  "scripts/**",
  "eslint.config.mjs",
  "next.config.mjs",
  "postcss.config.mjs",
];

const config = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "dist/**",
      "coverage/**",
      "next-env.d.ts",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    files: codeFiles,
    plugins: { local: localPlugin },
    rules: {
      // Platform safety. Nothing writes to a stream outside the structured logger, and nothing
      // builds code at runtime.
      "no-console": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-alert": "error",
      "no-debugger": "error",
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "always"],

      // Platform boundaries.
      "local/english-only-source": "error",
      "local/no-process-env": "error",
    },
  },
  {
    files: typeScriptFiles,
    languageOptions: {
      parserOptions: {
        // Type information makes the promise rules below possible. The project service reads
        // tsconfig.json, so a rule sees the same types the compiler does.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: typeScriptFiles,
    rules: {
      // Strict typing: close every escape from the type system.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "as" },
      ],
      "@typescript-eslint/no-require-imports": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
          minimumDescriptionLength: 10,
        },
      ],
      "@typescript-eslint/no-empty-object-type": "error",
      "@typescript-eslint/no-wrapper-object-types": "error",
      "@typescript-eslint/no-namespace": "error",
      "@typescript-eslint/no-unsafe-function-type": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",

      // Promises: a payment, a webhook and an email all cross an asynchronous boundary, so a
      // forgotten await is a correctness bug rather than a style preference.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
  {
    files: environmentOwners,
    rules: {
      "local/no-process-env": "off",
    },
  },
];

export default config;
