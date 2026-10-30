// path: scripts/eslint-rules/english-only-source.mjs

/**
 * English-only source guard.
 *
 * MASTER_PROMPT rule 1 and FEATURE_LIST section 1 require English only in code, UI, comments,
 * seeds, templates, file names and content strings. The string catalog gate already checks the
 * copy; this rule checks everything else, so a translated comment, a copy pasted sentence or an
 * emoji cannot reach the repository through a code file.
 *
 * The rule reads the file text once. Every code point above U+007E is reported unless it is one
 * of the typographic characters allowed below, which are the same characters the i18n gate
 * allows inside a message. A reported character carries its code point and its position, so a
 * failure names the exact place to fix.
 */

/** En dash, em dash, curly quotes, ellipsis, bullet and middle dot. Nothing else is allowed. */
const allowedNonAsciiCharacters = new Set([
  "\u2013",
  "\u2014",
  "\u2018",
  "\u2019",
  "\u201C",
  "\u201D",
  "\u2026",
  "\u2022",
  "\u00B7",
]);

const printableAsciiLimit = 126;

export const englishOnlySource = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require English only source: no character outside printable ASCII except the allowed typographic set.",
    },
    schema: [],
    messages: {
      nonEnglishCharacter:
        "Source must be English only: found U+{{codePoint}} at this position.",
    },
  },

  create(context) {
    return {
      Program(node) {
        const sourceCode = context.sourceCode;
        const text = sourceCode.text;

        for (let index = 0; index < text.length; index += 1) {
          const codePoint = text.codePointAt(index);

          if (codePoint === undefined || codePoint <= printableAsciiLimit) {
            continue;
          }

          const character = String.fromCodePoint(codePoint);

          if (!allowedNonAsciiCharacters.has(character)) {
            context.report({
              node,
              loc: sourceCode.getLocFromIndex(index),
              messageId: "nonEnglishCharacter",
              data: {
                codePoint: codePoint.toString(16).toUpperCase().padStart(4, "0"),
              },
            });
          }

          // A surrogate pair is two code units; skip the second one.
          index += character.length - 1;
        }
      },
    };
  },
};
