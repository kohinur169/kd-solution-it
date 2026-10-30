// path: lib/env/generate-example.ts
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  ENVIRONMENT_VARIABLES,
  type EnvironmentRequirement,
  type EnvironmentVariableDefinition,
} from "./manifest.ts";

/**
 * Writes or checks .env.example from the environment manifest.
 *
 *   node lib/env/generate-example.ts           writes the file
 *   node lib/env/generate-example.ts --check   fails when the file on disk differs
 *
 * Run directly by Node.js 26, which executes TypeScript natively. That keeps the generator
 * in the same language and the same type contract as the runtime validation, so the example
 * file a developer reads is produced by the same source that the server validates.
 */

const exampleFilePath = fileURLToPath(new URL("../../.env.example", import.meta.url));

const requirementLabels: Record<EnvironmentRequirement, string> = {
  always: "Required in every environment.",
  production: "Required in production.",
  conditional: "Conditionally required.",
  optional: "Optional.",
};

function describeRequirement(definition: EnvironmentVariableDefinition): string {
  const condition = definition.requiredWhen;
  if (definition.requirement === "conditional" && condition !== undefined) {
    return `Required when ${condition.variable} is "${condition.equals}".`;
  }
  if (definition.requirement === "optional" && definition.default !== undefined) {
    return `Optional. Default: ${definition.default}.`;
  }
  return requirementLabels[definition.requirement];
}

function renderVariable(definition: EnvironmentVariableDefinition): string {
  const heading = definition.secret
    ? `# ${definition.name} (secret, never commit a real value)`
    : `# ${definition.name}`;

  return [
    heading,
    `# ${definition.description}`,
    `# ${describeRequirement(definition)}`,
    `${definition.name}=${definition.example}`,
  ].join("\n");
}

function renderExampleFile(): string {
  const header = [
    "# path: .env.example",
    "#",
    "# KD SOLUTION IT - environment contract.",
    "#",
    "# Generated from lib/env/manifest.ts by `npm run env:example`. Do not edit by hand:",
    "# `npm run check:env` fails when this file and the manifest disagree, and that check runs",
    "# inside `npm run verify`.",
    "#",
    "# Every value below is a placeholder, never a real credential. Copy this file to",
    "# .env.local for development and replace the placeholders there. .env.local is git",
    "# ignored, and no real value belongs in this repository.",
    "#",
    "# The server validates this contract at boot through lib/env/server.ts and refuses to",
    "# start when a required variable is missing or malformed.",
  ].join("\n");

  const sections = ENVIRONMENT_VARIABLES.map(renderVariable).join("\n\n");

  return `${header}\n\n${sections}\n`;
}

const expectedContent = renderExampleFile();
const checkOnly = process.argv.includes("--check");

if (checkOnly) {
  let actualContent = "";
  try {
    actualContent = readFileSync(exampleFilePath, "utf8");
  } catch {
    process.stderr.write(
      "check:env failed: .env.example is missing. Run `npm run env:example`.\n",
    );
    process.exitCode = 1;
    throw new Error("missing .env.example");
  }

  if (actualContent !== expectedContent) {
    process.stderr.write(
      "check:env failed: .env.example differs from lib/env/manifest.ts. " +
        "Run `npm run env:example` and commit the result.\n",
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `check:env passed: .env.example matches ${ENVIRONMENT_VARIABLES.length} manifest variables\n`,
    );
  }
} else {
  writeFileSync(exampleFilePath, expectedContent, "utf8");
  process.stdout.write(
    `env:example written: .env.example with ${ENVIRONMENT_VARIABLES.length} variables\n`,
  );
}
