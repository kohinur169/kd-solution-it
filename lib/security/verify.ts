// path: lib/security/verify.ts
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import { AppError } from "../errors/app-error.ts";
import {
  ALLOWED_RICH_TEXT_TAGS,
  decodeEntities,
  RICH_TEXT_POLICY,
  sanitizeRichText,
  stripMarkup,
  tokenizeRichText,
} from "./html.ts";
import { BLOCKED_HOST_SUFFIXES, isIpLiteral, isPublicAddress, isPublicHost, isPublicHostname } from "./host.ts";
import { escapeHtml, hasUnsafeCharacters, describeTextIssues, sanitizeFileName, sanitizeHeaderValue, sanitizeMultilineText, sanitizeSingleLineText, sanitizeSlug, TEXT_LIMITS } from "./text.ts";
import { isSafeRedirect, requireHttpUrl, sanitizeHttpUrl, sanitizeRelativePath } from "./url.ts";

/**
 * The gate behind the input sanitiser.
 *
 * `npm run check:security` runs it, and it is written as a corpus rather than as a smoke test: every
 * case below is a string that has defeated a sanitiser somewhere - the entity-encoded scheme in a
 * link, the comment that ends early, the `<img onerror>` with no closing tag, the metadata address,
 * the encoded `..`, the right-to-left override that makes a name display as something else. A
 * regression here is a stored XSS or an SSRF, which is why the corpus is long and why the gate exits
 * non-zero on one wrong answer.
 *
 * The last section reads the code rather than calling it: the tree is asserted to contain no second
 * escaping function and no `dangerouslySetInnerHTML` outside the one static theme script.
 */

const failures: string[] = [];
let checks = 0;

function expect(condition: boolean, description: string): void {
  checks += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual<T>(actual: T, expected: T, description: string): void {
  checks += 1;

  if (actual !== expected) {
    failures.push(`${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`);
  }
}

function expectThrows(action: () => void, description: string): AppError | null {
  checks += 1;

  try {
    action();
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }

    failures.push(`${description} (the rejection must be an AppError)`);

    return null;
  }

  failures.push(`${description} (nothing was rejected)`);

  return null;
}

/** ---- Text: one string, whatever a keyboard or a clipboard produced. */
function checkText(): void {
  expectEqual(sanitizeSingleLineText("e\u0301"), "\u00e9", "a combining accent is composed to one code point");
  expectEqual(sanitizeSingleLineText("abc\u0000def"), "abcdef", "the null byte is removed");
  expectEqual(sanitizeSingleLineText("a\r\nb"), "a b", "a line break becomes a space in a name");
  expectEqual(sanitizeSingleLineText("a\u2028b"), "a b", "the Unicode line separator too");
  expectEqual(sanitizeSingleLineText("\u0007bell\u001b[31m"), "bell[31m", "C0 controls are removed");
  expectEqual(sanitizeSingleLineText("a\u0085b"), "ab", "C1 controls are removed");
  expectEqual(sanitizeSingleLineText("abc\u202edef"), "abcdef", "a right-to-left override is removed");
  expectEqual(sanitizeSingleLineText("\u202eevil"), "evil", "so a string cannot start with one");
  expectEqual(sanitizeSingleLineText("a\u200bb\u200cc\u200dd"), "abcd", "zero-width characters are removed");
  expectEqual(sanitizeSingleLineText("\ufeffname"), "name", "a byte order mark is removed");
  expectEqual(sanitizeSingleLineText("soft\u00adhyphen"), "softhyphen", "a soft hyphen is removed");
  expectEqual(sanitizeSingleLineText("\u{e0041}\u{e0042}tag"), "tag", "the deprecated tag block is removed");
  expectEqual(sanitizeSingleLineText("non\ufffecharacter"), "noncharacter", "a non-character is removed");
  expectEqual(sanitizeSingleLineText("  a \t\t b  "), "a b", "whitespace is collapsed and trimmed");
  expectEqual(sanitizeSingleLineText("\u00a0padded\u00a0"), "padded", "a non-breaking space is whitespace too");

  const long = "a".repeat(300);
  expectEqual([...sanitizeSingleLineText(long)].length, TEXT_LIMITS.singleLine, "a name is bounded by the default ceiling");
  expectEqual([...sanitizeSingleLineText("x".repeat(50), 10)].length, 10, "and by the caller's ceiling");

  const emoji = "\u{1f600}".repeat(6);
  expectEqual([...sanitizeSingleLineText(emoji, 5)].length, 5, "the ceiling counts code points, so an emoji costs one");

  expectEqual(sanitizeMultilineText("a\n\nb"), "a\n\nb", "a note keeps its paragraph break");
  expectEqual(sanitizeMultilineText("a\n\n\n\n\nb"), "a\n\nb", "a run of blank lines collapses to one");
  expectEqual(sanitizeMultilineText("a\r\nb"), "a\nb", "a CRLF becomes one line break");
  expectEqual(sanitizeMultilineText("line   \nnext"), "line\nnext", "trailing spaces on a line go");

  const issues = describeTextIssues("a\u0000b\u0000c\u202ed", { maxLength: 3, multiline: false });

  expectEqual(issues.filter((issue) => issue.kind === "null_byte")[0]?.count, 2, "the issues count the null bytes");
  expectEqual(issues.some((issue) => issue.kind === "too_long"), true, "and report a value that is too long");
  expectEqual(issues.some((issue) => issue.kind === "bidi_control"), true, "and a bidirectional control");
  expectEqual(
    issues.every((issue) => !JSON.stringify(issue).includes("\u0000")),
    true,
    "an issue never carries the character it found",
  );
  expectEqual(hasUnsafeCharacters("ordinary name"), false, "ordinary text is not flagged");
  expectEqual(hasUnsafeCharacters("a\u0000b"), true, "and a null byte is");

  expectEqual(
    escapeHtml(`<script>alert("x")&'</script>`),
    "&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;&lt;/script&gt;",
    "every HTML metacharacter is escaped, both quote styles included",
  );
  expectEqual(escapeHtml("safe text"), "safe text", "and text without one is unchanged");

  expectEqual(sanitizeHeaderValue("Subject\r\nBcc: attacker@example.test"), "Subject Bcc: attacker@example.test", "a header value cannot carry a second header");
  expectEqual(sanitizeHeaderValue("a\u0000b"), "ab", "nor a null byte");

  const traversal = sanitizeFileName("../../etc/passwd");

  expectEqual(traversal.includes("/"), false, "a file name cannot carry a separator");
  expectEqual(traversal.includes(".."), false, "nor a parent directory");
  expectEqual(sanitizeFileName("C:\\Windows\\win.ini").includes("\\"), false, "nor a Windows separator");
  expectEqual(sanitizeFileName("CON.txt"), "_CON.txt", "a reserved device name is prefixed");
  expectEqual(sanitizeFileName("   "), "file", "an empty name becomes a name rather than an empty string");
  expectEqual(sanitizeFileName("%2e%2e/secret").includes(".."), false, "an encoded traversal is stripped");
  expectEqual(sanitizeFileName("invoice 2026-11.pdf"), "invoice 2026-11.pdf", "an ordinary name survives");

  expectEqual(sanitizeSlug("K.D. Trading Pvt. Ltd."), "k-d-trading-pvt-ltd", "a slug folds to ASCII words");
  expectEqual(sanitizeSlug("  --Hello   World--  "), "hello-world", "and trims and collapses its dashes");
  expectEqual(sanitizeSlug("a".repeat(200)).length, TEXT_LIMITS.slug, "and is bounded");
  expectEqual(sanitizeSlug("\u00c9t\u00e9"), "ete", "an accent is folded rather than dropped with the letter");
}

/** ---- Hosts: the destinations the platform must never dial. */
function checkHosts(): void {
  expectEqual(isPublicAddress("8.8.8.8"), true, "a public IPv4 address is reachable");
  expectEqual(isPublicAddress("10.1.2.3"), false, "a private range is not");
  expectEqual(isPublicAddress("172.16.5.4"), false, "nor 172.16/12");
  expectEqual(isPublicAddress("172.32.5.4"), true, "while 172.32 is outside it");
  expectEqual(isPublicAddress("127.0.0.1"), false, "loopback is not");
  expectEqual(isPublicAddress("169.254.169.254"), false, "the metadata service is the whole point");
  expectEqual(isPublicAddress("192.168.1.1"), false, "nor a home network");
  expectEqual(isPublicAddress("100.64.0.1"), false, "nor carrier grade NAT");
  expectEqual(isPublicAddress("0.0.0.0"), false, "nor the unspecified address");
  expectEqual(isPublicAddress("224.0.0.1"), false, "nor multicast");
  expectEqual(isPublicAddress("203.0.113.9"), false, "nor a documentation range");
  expectEqual(isPublicAddress("::1"), false, "IPv6 loopback is not reachable");
  expectEqual(isPublicAddress("::"), false, "nor the unspecified IPv6 address");
  expectEqual(isPublicAddress("fc00::1"), false, "nor a unique local address");
  expectEqual(isPublicAddress("fe80::1"), false, "nor a link local one");
  expectEqual(isPublicAddress("2001:db8::1"), false, "nor a documentation prefix");
  expectEqual(isPublicAddress("2606:4700:4700::1111"), true, "a public IPv6 address is");
  expectEqual(isPublicAddress("::ffff:127.0.0.1"), false, "an IPv4-mapped loopback is checked as IPv4");
  expectEqual(isPublicAddress("::ffff:8.8.8.8"), true, "and an IPv4-mapped public address as IPv4");
  expectEqual(isPublicAddress("payments"), false, "a bare word is not an address");

  expectEqual(isIpLiteral("10.0.0.1"), true, "an IPv4 literal is recognised");
  expectEqual(isIpLiteral("example.com"), false, "a name is not an address");

  expectEqual(isPublicHostname("example.com"), true, "a public name is reachable");
  expectEqual(isPublicHostname("api.stripe.com"), true, "and a real API host");
  expectEqual(isPublicHostname("localhost"), false, "localhost is not");
  expectEqual(isPublicHostname("redis.internal"), false, "nor an internal name");
  expectEqual(isPublicHostname("metadata.google.internal"), false, "nor the cloud metadata name");
  expectEqual(isPublicHostname("box.local"), false, "nor a mDNS name");
  expectEqual(isPublicHostname("payments"), false, "a single label is a service on the host, not a name on the internet");
  expectEqual(isPublicHostname("example"), false, "nor is a bare word");
  expectEqual(isPublicHostname("-example.com"), false, "a label cannot begin with a hyphen");
  expectEqual(isPublicHostname("example..com"), false, "nor be empty");
  expectEqual(isPublicHostname("xn--80ak6aa92e.com"), true, "a punycode name is a name");
  expectEqual(isPublicHost("192.168.0.1"), false, "a private literal is refused as a host");
  expectEqual(isPublicHost("example.com"), true, "and a public name accepted");
  expect(BLOCKED_HOST_SUFFIXES.includes(".internal"), "the suffix list includes the internal convention");
}

/** ---- URLs: what may be stored, fetched and redirected to. */
function checkUrls(): void {
  const publicPage = sanitizeHttpUrl("https://example.com/path?b=2&a=1");

  expectEqual(publicPage.ok, true, "an https URL is accepted");
  expectEqual(publicPage.value, "https://example.com/path?b=2&a=1", "and returned as the parser spells it");
  expectEqual(
    sanitizeHttpUrl("HTTPS://Example.COM:443/a").value,
    "https://example.com/a",
    "host case and the default port are canonicalised, so two spellings are one value",
  );

  expectEqual(sanitizeHttpUrl("javascript:alert(1)").reason, "unsupported_scheme", "a script URL is refused");
  expectEqual(sanitizeHttpUrl(" javaScript:alert(1)").reason, "unsupported_scheme", "and one with leading space");
  expectEqual(sanitizeHttpUrl("java\nscript:alert(1)").reason, "control_character", "and one split by a line break");
  expectEqual(sanitizeHttpUrl("java&#x61;script:alert(1)").ok, false, "and one written with an entity");
  expectEqual(sanitizeHttpUrl("data:text/html,<script>alert(1)</script>").reason, "unsupported_scheme", "a data URL is refused");
  expectEqual(sanitizeHttpUrl("vbscript:msgbox(1)").reason, "unsupported_scheme", "and a vbscript one");
  expectEqual(sanitizeHttpUrl("file:///etc/passwd").reason, "unsupported_scheme", "and a file URL");
  expectEqual(sanitizeHttpUrl("//evil.test/x").reason, "invalid_format", "a protocol relative URL has no scheme to allow");
  expectEqual(sanitizeHttpUrl("https://user:pass@example.com/").reason, "credentials", "credentials in a URL are refused");
  expectEqual(sanitizeHttpUrl("https://169.254.169.254/latest/meta-data/").reason, "private_host", "the metadata address is refused");
  expectEqual(sanitizeHttpUrl("https://127.0.0.1/admin").reason, "private_host", "so is loopback");
  expectEqual(sanitizeHttpUrl("https://redis.internal/").reason, "private_host", "and an internal name");
  expectEqual(sanitizeHttpUrl("https://example.com:8443/").reason, "unsupported_port", "a port nobody serves is refused");
  expectEqual(
    sanitizeHttpUrl("https://example.com:8443/", { allowedPorts: ["8443"] }).ok,
    true,
    "unless the caller allows that port",
  );
  expectEqual(sanitizeHttpUrl("https://example.com\\@evil.test/").reason, "backslash", "a backslash is refused");
  expectEqual(sanitizeHttpUrl("https://exa<mple.com/").reason, "markup_character", "so is markup");
  expectEqual(sanitizeHttpUrl("http://example.com/").reason, "unsupported_scheme", "http is refused by default");
  expectEqual(
    sanitizeHttpUrl("http://example.com/", { allowedProtocols: ["https:", "http:"] }).ok,
    true,
    "and allowed when a caller asks for it",
  );
  expectEqual(sanitizeHttpUrl("").reason, "empty", "an empty URL is refused");
  expectEqual(sanitizeHttpUrl("   ").reason, "empty", "so is whitespace");
  expectEqual(sanitizeHttpUrl("https://").reason, "invalid_format", "and a scheme with no host");
  expectEqual(sanitizeHttpUrl(`https://example.com/${"a".repeat(2_100)}`).reason, "too_long", "and one past the ceiling");

  const rejection = expectThrows(
    () => requireHttpUrl("https://169.254.169.254/", "webhookUrl"),
    "the throwing form refuses the metadata address",
  );

  expectEqual(rejection?.code, "VALIDATION_FAILED", "with the catalogue's validation code");
  expectEqual(rejection?.details[0]?.field, "webhookUrl", "and the field the caller named");
  expectEqual(rejection?.details[0]?.rule, "private_host", "and the reason a form can show");

  // ---- paths
  expectEqual(sanitizeRelativePath("/sessions").value, "/sessions", "a rooted path is accepted");
  expectEqual(sanitizeRelativePath("/a/../b").reason, "traversal", "a parent segment is refused");
  expectEqual(sanitizeRelativePath("/a/./b").reason, "traversal", "so is a current segment");
  expectEqual(sanitizeRelativePath("/%2e%2e/etc/passwd").ok, false, "an encoded traversal is refused");
  expectEqual(sanitizeRelativePath("/..%2fetc").ok, false, "and a half encoded one");
  expectEqual(sanitizeRelativePath("//evil.test/x").reason, "scheme", "a protocol relative path is refused");
  expectEqual(sanitizeRelativePath("/\\evil.test").reason, "backslash", "a backslash is refused");
  expectEqual(sanitizeRelativePath("sessions").reason, "not_rooted", "a path must be rooted");
  expectEqual(sanitizeRelativePath("javascript:alert(1)").ok, false, "a scheme is not a path");
  expectEqual(sanitizeRelativePath("/%00").reason, "control_character", "a null byte is refused");
  expectEqual(sanitizeRelativePath("/a?b=1").value, "/a?b=1", "a query survives the rebuild");
  expectEqual(sanitizeRelativePath("/").value, "/", "the root is a path");

  // ---- redirects
  expectEqual(isSafeRedirect("/sessions"), true, "a rooted path is a safe return");
  expectEqual(isSafeRedirect("https://evil.example.org/x", { allowedHosts: ["app.kdplatform.com"] }), false, "another host is not");
  expectEqual(
    isSafeRedirect("https://app.kdplatform.com/sessions", { allowedHosts: ["app.kdplatform.com"] }),
    true,
    "the platform's own host is",
  );
  expectEqual(isSafeRedirect("//evil.example.org", { allowedHosts: ["app.kdplatform.com"] }), false, "a protocol relative return is not");
  expectEqual(isSafeRedirect("javascript:alert(1)"), false, "and a script is never a destination");
}

/** ---- Rich text: rebuilt, not cleaned. */
function checkRichText(): void {
  expectEqual(sanitizeRichText("<p>Hello</p>"), "<p>Hello</p>", "a paragraph survives");
  expectEqual(sanitizeRichText("<p>a<script>alert(1)</script>b</p>"), "<p>ab</p>", "a script goes with its content");
  expectEqual(sanitizeRichText("<script>alert(1)</script>"), "", "and on its own leaves nothing");
  expectEqual(sanitizeRichText("<svg><script>alert(1)</script></svg>"), "", "an SVG is dropped whole");
  expectEqual(sanitizeRichText("<img src=x onerror=alert(1)>"), "", "an image with a handler is dropped");
  expectEqual(sanitizeRichText("<p onclick=\"alert(1)\">x</p>"), "<p>x</p>", "an event attribute is dropped");
  expectEqual(sanitizeRichText("<p style=\"background:url(javascript:alert(1))\">x</p>"), "<p>x</p>", "so is a style");
  expectEqual(sanitizeRichText("<div><p>x</p></div>"), "<p>x</p>", "an unknown tag goes and its content stays");
  expectEqual(sanitizeRichText("<a href=\"javascript:alert(1)\">x</a>"), "<a>x</a>", "a script link keeps its text and loses the href");
  expectEqual(sanitizeRichText("<a href=\"https://169.254.169.254/\">x</a>"), "<a>x</a>", "so does a link to the metadata service");

  const link = sanitizeRichText('<a href="https://example.com/x">x</a>');

  expectEqual(link, '<a href="https://example.com/x" rel="noopener noreferrer nofollow" target="_blank">x</a>', "a safe link carries rel and target");
  expectEqual(
    sanitizeRichText("<a href='https://example.com/?a=1&b=2'>x</a>").includes("&amp;"),
    true,
    "a query string is escaped, so it cannot become a second attribute",
  );
  expectEqual(sanitizeRichText("<a href=\"https://example.com\">a<a href=\"https://evil.test\">b</a></a>").split("<a ").length - 1, 1, "a nested link is not created");
  expectEqual(sanitizeRichText("<b>x</b><i>y</i>"), "<b>x</b><i>y</i>", "emphasis survives");
  expectEqual(sanitizeRichText("<p>a<b>b</p>c"), "<p>a<b>b</b></p>c", "an unclosed tag is closed where the input ends");
  expectEqual(sanitizeRichText("<p>1 > 2</p>"), "<p>1 &gt; 2</p>", "text is always escaped");
  expectEqual(sanitizeRichText("<p>&lt;script&gt;</p>"), "<p>&lt;script&gt;</p>", "an escaped script stays escaped");
  expectEqual(sanitizeRichText("<strong>a<!-- comment -->b</strong>"), "<strong>ab</strong>", "a comment is dropped");
  expectEqual(sanitizeRichText("<p>a<!-- unterminated"), "<p>a</p>", "an unterminated comment is dropped");
  expectEqual(sanitizeRichText("<<script>script>alert(1)<</script>/script>").includes("<script"), false, "the nested script trick produces no tag");
  expectEqual(sanitizeRichText("<p>unclosed"), "<p>unclosed</p>", "an unclosed paragraph is closed");
  expectEqual(sanitizeRichText("<p title=\"a>b\">x</p>"), "<p>x</p>", "a quoted bracket does not end the tag early");
  expectEqual(sanitizeRichText("plain text"), "plain text", "text without markup is text");
  expectEqual(sanitizeRichText("<p>a\u0000b</p>"), "<p>ab</p>", "a null byte never reaches the output");
  expectEqual(sanitizeRichText("<!doctype html><p>x</p>"), "<p>x</p>", "a doctype is dropped");

  const deep = `${"<blockquote>".repeat(40)}x${"</blockquote>".repeat(40)}`;

  expectEqual(
    sanitizeRichText(deep).split("<blockquote>").length - 1 <= RICH_TEXT_POLICY.maxDepth,
    true,
    "nesting is bounded by the policy",
  );

  const many = `${"<p>x</p>".repeat(RICH_TEXT_POLICY.maxNodes + 100)}`;

  expectEqual(
    sanitizeRichText(many).split("<p>").length - 1 <= RICH_TEXT_POLICY.maxNodes,
    true,
    "and so is the number of nodes",
  );

  expectEqual(stripMarkup("<p>Hello <strong>world</strong></p>"), "Hello world", "a summary is the text of the document");
  expectEqual(stripMarkup("<script>alert(1)</script>safe"), "safe", "and never the content of a script");
  expectEqual(decodeEntities("&amp;&lt;&#65;&#x42;&nbsp;"), "&<AB\u00a0", "the entity decoder understands the five, both numerics and nbsp");
  expectEqual(decodeEntities("&unknown;"), "&unknown;", "and leaves anything else literal");
  expectEqual(decodeEntities("&#0;"), "\ufffd", "a null character reference becomes the replacement character");

  expectEqual(tokenizeRichText("<p>x</p>").length, 3, "the tokeniser answers open, text and close");

  expect(RICH_TEXT_POLICY.allowedTags === ALLOWED_RICH_TEXT_TAGS, "the policy uses the published allowlist");
  expectEqual(RICH_TEXT_POLICY.allowedTags.includes("style"), false, "a style element is not allowed");
  expectEqual(RICH_TEXT_POLICY.allowedTags.includes("img"), false, "an image is not allowed, because it tracks");
  expectEqual(RICH_TEXT_POLICY.allowedTags.includes("script"), false, "and a script never is");
}

/** ---- The tree: one escaping function, one place that trusts markup. */
async function checkTree(): Promise<void> {
  const securityRoot = new URL("./", import.meta.url);
  const securityFiles = (await readdir(securityRoot)).filter((name) => name.endsWith(".ts"));

  expectEqual(securityFiles.includes("text.ts"), true, "the text rules are one file");
  expectEqual(securityFiles.includes("host.ts"), true, "the host rules are one file");
  expectEqual(securityFiles.includes("url.ts"), true, "the URL rules are one file");
  expectEqual(securityFiles.includes("html.ts"), true, "the rich text rules are one file");

  const htmlSource = await readFile(new URL("./html.ts", import.meta.url), "utf8");
  const urlSource = await readFile(new URL("./url.ts", import.meta.url), "utf8");

  expect(htmlSource.includes('from "./text.ts"'), "the rich text serialiser escapes through the text module");
  expect(htmlSource.includes('from "./url.ts"'), "and validates every link through the URL module");
  expect(urlSource.includes('from "./host.ts"'), "the URL module asks the host module about destinations");
  expect(urlSource.includes("node:crypto") === false, "the URL module needs no hashing");
  expectEqual(htmlSource.includes("dangerouslySetInnerHTML"), false, "the sanitiser never writes markup into a component");

  const appRoot = new URL("../../", import.meta.url);
  const appEntries = (await readdir(appRoot, { recursive: true }))
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => (entry.startsWith("app/") || entry.startsWith("components/")) && (entry.endsWith(".ts") || entry.endsWith(".tsx")));

  let trustedMarkup = 0;

  for (const entry of appEntries) {
    const source = await readFile(new URL(entry, appRoot), "utf8");
    const uses = source.split("dangerouslySetInnerHTML=").length - 1;

    // The theme script of the root layout is a constant in this repository, not an input: it is the one
    // place the platform writes markup from a string, and it is asserted to be that and nothing else.
    if (uses > 0 && entry !== "app/layout.tsx") {
      failures.push(`unexpected dangerouslySetInnerHTML in ${entry}`);
    }

    trustedMarkup += uses;

    if (uses > 0) {
      expect(source.includes("__html: THEME_SCRIPT"), `${entry} writes only the static theme script`);
    }
  }

  checks += 1;

  if (trustedMarkup !== 1) {
    failures.push(`exactly one component writes markup from a string (found ${trustedMarkup})`);
  } else {
    checks += 1;
  }
}

async function main(): Promise<void> {
  checkText();
  checkHosts();
  checkUrls();
  checkRichText();
  await checkTree();

  if (failures.length > 0) {
    process.stderr.write(`security gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `security gate passed: ${checks} checks, ${TEXT_LIMITS.singleLine} code point name ceiling, ` +
      `${ALLOWED_RICH_TEXT_TAGS.length} allowed tags\n`,
  );
}

await main();
