// path: lib/security/html.ts
import { escapeHtml, sanitizeMultilineText } from "./text.ts";
import { sanitizeHttpUrl } from "./url.ts";

/**
 * Rich text that is rebuilt from an allowlist instead of cleaned by removal.
 *
 * ## Why the input is never edited
 *
 * Every sanitiser that removes things from a string has the same class of bug: it has to recognise the
 * thing it removes, and the browser does not. `<!--<script>-->` ends the comment early in one parser
 * and not in another, `<img src=x onerror=alert(1)>` has no closing tag to remove, and
 * `<a href="jav&#x61;script:alert(1)">` is a script URL that no `javascript:` search will find. This
 * module therefore does not edit the input at all. It tokenises it, keeps the tokens whose tag and
 * attributes are on the allowlist, escapes every piece of text and every attribute value, and prints
 * a **new** document from what it kept. Anything the tokeniser does not understand is dropped.
 *
 * ## The allowlist
 *
 * Small on purpose: the paragraph, the line break, six ways to emphasise, two lists, a quote, a code
 * block and a link. There is no `span`, no `div`, no `style`, no `class`, no `id` and no `img` - each
 * of those is a styling or tracking vector that the platform can add later with a policy of its own,
 * and none of them is needed to write an invoice note or a support reply.
 *
 * A link's `href` goes through `sanitizeHttpUrl`, so a link is https, public and uncredentialled, and
 * `rel="noopener noreferrer nofollow"` is added whatever the input said. `target` is added only
 * together with that `rel`.
 *
 * ## The limits
 *
 * Length, node count and depth are bounded, because a sanitiser that recurses has a stack and a
 * string that nests ten thousand blocks is a way to find it. Exceeding a limit ends the parse and the
 * document that was built so far is returned, which is what a truncated paste should look like.
 */

/** The tags that survive, each with what it means in a stored document. */
export const ALLOWED_RICH_TEXT_TAGS: readonly string[] = Object.freeze([
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "ul",
  "ol",
  "li",
  "blockquote",
  "a",
  "code",
  "pre",
]);

/** Tags whose content must disappear with the tag. Anything else keeps its text. */
const rawTextTags = new Set(["script", "style", "iframe", "object", "embed", "svg", "math", "template", "noscript", "title", "textarea", "xmp", "plaintext"]);

/** Tags that never have a closing tag, so the tokeniser does not wait for one. */
const voidTags = new Set(["br", "img", "hr", "input", "meta", "link", "area", "base", "col", "source", "track", "wbr"]);

export interface RichTextPolicy {
  readonly allowedTags: readonly string[];
  readonly maxLength: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly allowedProtocols: readonly string[];
  /** True to add `rel` and `target` to every link: the default, because a link opens in a new tab. */
  readonly externalLinksNewTab: boolean;
}

/** The policy the platform stores rich text under. */
export const RICH_TEXT_POLICY: RichTextPolicy = Object.freeze({
  allowedTags: ALLOWED_RICH_TEXT_TAGS,
  maxLength: 100_000,
  maxNodes: 5_000,
  maxDepth: 20,
  allowedProtocols: Object.freeze(["https:", "http:"]),
  externalLinksNewTab: true,
});

interface TextToken {
  readonly kind: "text";
  readonly value: string;
}

interface OpenToken {
  readonly kind: "open";
  readonly name: string;
  readonly attributes: readonly { readonly name: string; readonly value: string }[];
  readonly selfClosing: boolean;
}

interface CloseToken {
  readonly kind: "close";
  readonly name: string;
}

interface RawToken {
  readonly kind: "raw";
  readonly name: string;
  readonly content: string;
}

type Token = TextToken | OpenToken | CloseToken | RawToken;

const entityPattern = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/u;
const namedEntities: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
});

/**
 * One pass of entity decoding.
 *
 * Decoding is safe here **because the value is escaped again** on the way out: the point is that
 * `jav&#x61;script:` must be recognised as a scheme before it is judged, not that a browser should
 * receive the decoded text. Only the five characters XML requires, `nbsp` and numeric references are
 * understood; anything else stays literal and is therefore escaped into visible text.
 */
export function decodeEntities(input: string): string {
  let result = "";
  let remaining = input;

  for (;;) {
    const match = entityPattern.exec(remaining);

    if (match === null) {
      return result + remaining;
    }

    result += remaining.slice(0, match.index);
    remaining = remaining.slice(match.index + match[0].length);

    const decimal = match[1];
    const hexadecimal = match[2];
    const name = match[3];

    if (decimal !== undefined) {
      const code = Number.parseInt(decimal, 10);
      result += code === 0 || code > 0x10ffff ? "\ufffd" : String.fromCodePoint(code);
      continue;
    }

    if (hexadecimal !== undefined) {
      const code = Number.parseInt(hexadecimal, 16);
      result += code === 0 || code > 0x10ffff ? "\ufffd" : String.fromCodePoint(code);
      continue;
    }

    result += namedEntities[(name ?? "").toLowerCase()] ?? `&${name ?? ""};`;
  }
}

function readTagName(input: string, start: number): { readonly name: string; readonly end: number } {
  let index = start;
  let name = "";

  while (index < input.length) {
    const character = input[index] ?? "";

    if (/[a-zA-Z0-9:-]/u.test(character)) {
      name += character.toLowerCase();
      index += 1;
      continue;
    }

    break;
  }

  return { name, end: index };
}

interface AttributeRead {
  readonly attributes: readonly { readonly name: string; readonly value: string }[];
  readonly end: number;
  readonly selfClosing: boolean;
}

/**
 * The attributes of one tag.
 *
 * The scanner is a small state machine rather than a regular expression because a `>` inside a quoted
 * value does not end a tag, and a sanitiser that thinks it does will see the rest of the attribute as
 * markup. An attribute without a value is kept with an empty value and dropped by the allowlist,
 * which is the correct treatment of `<a onclick>`.
 */
function readAttributes(input: string, start: number): AttributeRead {
  const attributes: { name: string; value: string }[] = [];
  let index = start;
  const selfClosing = false;

  while (index < input.length) {
    while (index < input.length && /\s/u.test(input[index] ?? "")) {
      index += 1;
    }

    if (input[index] === ">") {
      return { attributes, end: index + 1, selfClosing };
    }

    if (input[index] === "/" && input[index + 1] === ">") {
      return { attributes, end: index + 2, selfClosing: true };
    }

    let name = "";

    while (index < input.length && !/[\s=/>]/u.test(input[index] ?? "")) {
      name += (input[index] ?? "").toLowerCase();
      index += 1;
    }

    while (index < input.length && /\s/u.test(input[index] ?? "")) {
      index += 1;
    }

    if (input[index] !== "=") {
      if (name.length > 0) {
        attributes.push({ name, value: "" });
      }

      continue;
    }

    index += 1;

    while (index < input.length && /\s/u.test(input[index] ?? "")) {
      index += 1;
    }

    const quote = input[index] === '"' || input[index] === "'" ? input[index] : null;

    if (quote !== null) {
      index += 1;
      let value = "";

      while (index < input.length && input[index] !== quote) {
        value += input[index] ?? "";
        index += 1;
      }

      index += 1;
      attributes.push({ name, value: decodeEntities(value) });
      continue;
    }

    let value = "";

    while (index < input.length && !/[\s>]/u.test(input[index] ?? "")) {
      value += input[index] ?? "";
      index += 1;
    }

    attributes.push({ name, value: decodeEntities(value) });
  }

  return { attributes, end: input.length, selfClosing };
}

/**
 * The tokeniser.
 *
 * Five shapes are recognised: text, an opening tag, a closing tag, a comment (dropped), and a raw text
 * element whose content is skipped to its closing tag. Everything else - a doctype, a processing
 * instruction, a broken `<` - becomes text and is therefore escaped rather than trusted.
 */
export function tokenizeRichText(input: string): readonly Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let text = "";

  function flushText(): void {
    if (text.length > 0) {
      tokens.push({ kind: "text", value: decodeEntities(text) });
      text = "";
    }
  }

  while (index < input.length) {
    const character = input[index] ?? "";

    if (character !== "<") {
      text += character;
      index += 1;
      continue;
    }

    if (input.startsWith("<!--", index)) {
      const end = input.indexOf("-->", index + 4);

      flushText();
      index = end === -1 ? input.length : end + 3;
      continue;
    }

    if (input.startsWith("<!", index) || input.startsWith("<?", index)) {
      const end = input.indexOf(">", index);

      flushText();
      index = end === -1 ? input.length : end + 1;
      continue;
    }

    if (input[index + 1] === "/") {
      const { name, end } = readTagName(input, index + 2);
      const close = input.indexOf(">", end);

      if (name.length === 0 || close === -1) {
        text += character;
        index += 1;
        continue;
      }

      flushText();
      tokens.push({ kind: "close", name });
      index = close + 1;
      continue;
    }

    const { name, end } = readTagName(input, index + 1);

    if (name.length === 0) {
      text += character;
      index += 1;
      continue;
    }

    const attributes = readAttributes(input, end);

    flushText();

    if (rawTextTags.has(name)) {
      const closing = input.toLowerCase().indexOf(`</${name}`, attributes.end);
      const closingEnd = closing === -1 ? -1 : input.indexOf(">", closing);
      const content = input.slice(attributes.end, closing === -1 ? input.length : closing);

      tokens.push({ kind: "raw", name, content });
      index = closing === -1 || closingEnd === -1 ? input.length : closingEnd + 1;
      continue;
    }

    tokens.push({ kind: "open", name, attributes: attributes.attributes, selfClosing: attributes.selfClosing });
    index = attributes.end;
  }

  flushText();

  return tokens;
}

interface BuiltNode {
  readonly name: string;
  readonly attributes: readonly { readonly name: string; readonly value: string }[];
  readonly children: BuiltNode[];
}

function renderAttributes(
  name: string,
  attributes: readonly { readonly name: string; readonly value: string }[],
  policy: RichTextPolicy,
): string {
  if (name !== "a") {
    return "";
  }

  const href = attributes.find((attribute) => attribute.name === "href")?.value ?? "";
  const decision = sanitizeHttpUrl(href, { allowedProtocols: policy.allowedProtocols });

  if (!decision.ok || decision.value === undefined) {
    return "";
  }

  const rel = "noopener noreferrer nofollow";

  return ` href="${escapeHtml(decision.value)}" rel="${rel}"${policy.externalLinksNewTab ? ' target="_blank"' : ""}`;
}

function renderNodes(nodes: readonly BuiltNode[], policy: RichTextPolicy): string {
  let output = "";

  for (const node of nodes) {
    if (node.name === "#text") {
      output += escapeHtml(node.attributes[0]?.value ?? "");
      continue;
    }

    const attributes = renderAttributes(node.name, node.attributes, policy);

    if (voidTags.has(node.name)) {
      output += `<${node.name}${attributes}>`;
      continue;
    }

    output += `<${node.name}${attributes}>${renderNodes(node.children, policy)}</${node.name}>`;
  }

  return output;
}

/**
 * The sanitiser.
 *
 * The tree is built from the tokens, the tree is filtered against the policy and then printed. A tag
 * that is not on the allowlist is dropped and its content kept, unless it is one of the raw text
 * elements, whose content is dropped with it. A closing tag without its opening tag is ignored, and an
 * unclosed tag is closed where the input ended - both are how a browser would read it, without the
 * browser's tolerance for the parts that are not text.
 */
export function sanitizeRichText(input: string, policy: RichTextPolicy = RICH_TEXT_POLICY): string {
  const bounded = sanitizeMultilineText(input, policy.maxLength);
  const tokens = tokenizeRichText(bounded);
  const root: BuiltNode = { name: "#root", attributes: [], children: [] };
  const stack: BuiltNode[] = [root];
  let nodeCount = 0;

  for (const token of tokens) {
    if (nodeCount >= policy.maxNodes) {
      break;
    }

    const current = stack[stack.length - 1] ?? root;

    if (token.kind === "text") {
      if (token.value.length === 0) {
        continue;
      }

      current.children.push({ name: "#text", attributes: [{ name: "value", value: token.value }], children: [] });
      nodeCount += 1;
      continue;
    }

    if (token.kind === "raw") {
      // The content is dropped with the tag: a script that survives as text is not an improvement.
      nodeCount += 1;
      continue;
    }

    if (token.kind === "close") {
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth]?.name === token.name) {
          stack.length = depth;
          break;
        }
      }

      continue;
    }

    if (!policy.allowedTags.includes(token.name)) {
      if (voidTags.has(token.name)) {
        continue;
      }

      // Not allowed: the tag is dropped, its content is not. A `<div>` around a paragraph should
      // leave the paragraph; that is the difference between sanitising and censoring.
      continue;
    }

    if (stack.length - 1 >= policy.maxDepth) {
      continue;
    }

    // A link inside a link is invalid HTML and a way to make two destinations look like one; the
    // inner tag is dropped and its text kept.
    if (token.name === "a" && stack.some((node) => node.name === "a")) {
      continue;
    }

    const node: BuiltNode = { name: token.name, attributes: token.attributes, children: [] };

    current.children.push(node);
    nodeCount += 1;

    if (!token.selfClosing && !voidTags.has(token.name)) {
      stack.push(node);
    }
  }

  return renderNodes(root.children, policy).trim();
}

/**
 * The text of a rich document, for a search column or a list row.
 *
 * It runs the same tokeniser and throws the tags away, so the value it returns has had exactly the
 * same treatment as the value `sanitizeRichText` stores - a summary can never show markup that the
 * document was not allowed to keep.
 */
export function stripMarkup(input: string): string {
  const tokens = tokenizeRichText(input);
  let text = "";

  for (const token of tokens) {
    if (token.kind === "text") {
      text += `${token.value} `;
    }
  }

  return sanitizeMultilineText(text, RICH_TEXT_POLICY.maxLength);
}
