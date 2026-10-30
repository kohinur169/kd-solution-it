// path: scripts/eslint-rules/no-process-env.mjs

/**
 * Environment boundary guard.
 *
 * The platform reads the environment in exactly one place: `lib/env/`, where the manifest
 * declares every variable, zod validates it at boot and a typed accessor hands it on. A module
 * that reads `process.env` directly bypasses that contract, and it is also the shape of bug that
 * makes a production build need a secret it should not need.
 *
 * This rule reports `process.env` and `process["env"]` everywhere. The few files that own the
 * contract - the environment layer itself, the Next.js instrumentation hook and the Node.js
 * tooling scripts - turn the rule off in `eslint.config.mjs` by name, so every exemption is
 * visible in one list instead of living in review history.
 */

function isProcessIdentifier(node) {
  return node.type === "Identifier" && node.name === "process";
}

function isEnvMember(node) {
  if (node.computed) {
    return node.property.type === "Literal" && node.property.value === "env";
  }

  return node.property.type === "Identifier" && node.property.name === "env";
}

export const noProcessEnv = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Read the environment through lib/env/ instead of reading process.env directly.",
    },
    schema: [],
    messages: {
      noProcessEnv:
        "Do not read process.env here. Import the validated accessor from lib/env/ instead.",
    },
  },

  create(context) {
    return {
      MemberExpression(node) {
        if (!isProcessIdentifier(node.object) || !isEnvMember(node)) {
          return;
        }

        context.report({ node, messageId: "noProcessEnv" });
      },
    };
  },
};
