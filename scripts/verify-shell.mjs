// path: scripts/verify-shell.mjs
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { en } from "../lib/i18n/strings/en.ts";
import { THEME_PREFERENCES, THEME_SCRIPT, THEME_STORAGE_KEY } from "../components/providers/theme.ts";

/**
 * Shell and design token gate. Run with `npm run check:shell`, and inside `npm run verify`.
 *
 * STEP 003 decided that colour lives in `styles/tokens.css` and nowhere else, and STEP 010 built
 * the shell that consumes it. A decision in a document drifts; a check does not. This gate
 * refuses:
 *
 *   1. a colour literal or a palette step utility under `app/` or `components/`, because a
 *      component must name a semantic token;
 *   2. a layout that lost the pre-paint theme script, the skip link, the focusable content
 *      wrapper, the catalog driven `lang` and `dir`, or the provider boundary;
 *   3. a theme script and provider that disagree about the storage key or the allowed values;
 *   4. an error screen that leaks the raw error message, or a root boundary without its own
 *      document and stylesheet;
 *   5. a client component that imports a server only module or reads `process.env`, which would
 *      either fail the build or leak configuration into the browser.
 *
 * Files are read, not executed, so the gate is safe to run before a build.
 */

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const scannedRoots = ["app", "components"];
const scannedExtensions = new Set([".ts", ".tsx", ".css"]);

const failures = [];
let checkCount = 0;
let fileCount = 0;

function expect(condition, description) {
  checkCount += 1;

  if (!condition) {
    failures.push(description);
  }
}

function toRepositoryPath(absolutePath) {
  return relative(repositoryRoot, absolutePath).split(sep).join("/");
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolutePath)));
      continue;
    }

    const extension = entry.name.slice(entry.name.lastIndexOf("."));

    if (scannedExtensions.has(extension)) {
      files.push(absolutePath);
    }
  }

  return files;
}

const colourLiteralPattern = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\b|\brgba?\(|\bhsla?\(|\boklch\(/u;
const paletteStepPattern =
  /\b(?:bg|text|border|ring|divide|from|via|to|fill|stroke|placeholder|outline|decoration|accent|caret|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)\b/u;

async function checkTokenDiscipline() {
  for (const root of scannedRoots) {
    const files = await collectFiles(join(repositoryRoot, root));

    for (const file of files) {
      fileCount += 1;
      const repositoryPath = toRepositoryPath(file);
      const content = await readFile(file, "utf8");

      expect(
        !colourLiteralPattern.test(content),
        `${repositoryPath} contains a colour literal. Colour belongs in styles/tokens.css.`,
      );
      expect(
        !paletteStepPattern.test(content),
        `${repositoryPath} uses a palette step utility. Use a semantic token instead.`,
      );
    }
  }
}

async function readRepositoryFile(repositoryPath) {
  return readFile(join(repositoryRoot, repositoryPath), "utf8");
}

async function checkLayoutContract() {
  const layout = await readRepositoryFile("app/layout.tsx");

  expect(layout.includes("suppressHydrationWarning"), "the root html element must suppress the theme class hydration warning");
  expect(layout.includes("THEME_SCRIPT"), "the root layout must render the pre-paint theme script");
  expect(layout.includes("dangerouslySetInnerHTML"), "the theme script must be inlined before first paint");
  expect(layout.includes('href="#main-content"'), "the shell must offer a skip link");
  expect(layout.includes('id="main-content"'), "the shell must expose the skip link target");
  expect(layout.includes("tabIndex={-1}"), "the skip link target must be focusable");
  expect(layout.includes("lang={en.locale.code}"), "the document language must come from the catalog");
  expect(layout.includes("dir={en.locale.direction}"), "the writing direction must come from the catalog");
  expect(layout.includes("AppProviders"), "the shell must mount the provider boundary");
  expect(layout.includes('"./globals.css"'), "the root layout must import the global stylesheet");
}

function checkThemeAgreement() {
  expect(THEME_SCRIPT.includes(THEME_STORAGE_KEY), "the pre-paint script must use the shared storage key");
  expect(THEME_SCRIPT.includes('"light"'), "the pre-paint script must understand the light preference");
  expect(THEME_SCRIPT.includes('"dark"'), "the pre-paint script must understand the dark preference");
  expect(THEME_STORAGE_KEY.startsWith("kd-solution-it."), "the storage key must be namespaced");
  expect(THEME_PREFERENCES.length === 3, "three theme preferences must be declared");
  expect(THEME_PREFERENCES.includes("system"), "system must be a theme preference");
  expect(THEME_SCRIPT.length < 600, "the pre-paint script must stay small enough to read in a view source");
}

async function checkThemeConsumers() {
  const provider = await readRepositoryFile("components/providers/theme-provider.tsx");
  const toggle = await readRepositoryFile("components/ui/theme-toggle.tsx");

  expect(provider.includes("readStoredPreference"), "the provider must read the stored preference");
  expect(provider.includes("writeStoredPreference"), "the provider must persist a change");
  expect(provider.includes("subscribeToStoredPreference"), "the provider must follow a change made in another tab");
  expect(provider.includes("subscribeToSystemTheme"), "the provider must follow the operating system theme");
  expect(provider.includes("applyThemeClass"), "the provider must apply the class to the document");
  expect(!provider.includes("dark:"), "the provider must not carry hard coded utility variants");

  expect(toggle.includes("THEME_PREFERENCES"), "the switcher must render every preference");
  expect(toggle.includes("useTheme"), "the switcher must read the provider");
  expect(toggle.includes('role="group"'), "the switcher must be a labelled group");
  expect(toggle.includes("aria-pressed"), "each switcher option must expose its state");
  expect(toggle.includes('type="button"'), "the switcher options must be buttons");
  expect(toggle.includes("getMessage"), "the switcher labels must come from the catalog");
}

async function checkErrorScreens() {
  const segment = await readRepositoryFile("app/error.tsx");
  const root = await readRepositoryFile("app/global-error.tsx");

  expect(segment.includes('"use client"'), "the segment error screen must be a client component");
  expect(root.includes('"use client"'), "the root error screen must be a client component");
  expect(segment.includes("reset"), "the segment error screen must offer a retry");
  expect(root.includes("<html"), "the root error screen must render its own document element");
  expect(root.includes('"./globals.css"'), "the root error screen must load the stylesheet and the tokens");
  expect(!segment.includes("error.message"), "an error screen must not print the raw error message");
  expect(!root.includes("error.message"), "an error screen must not print the raw error message");
  expect(segment.includes("getMessage"), "the error copy must come from the catalog");
  expect(root.includes("getMessage"), "the error copy must come from the catalog");
}

async function checkClientBoundary() {
  const files = [];

  for (const root of scannedRoots) {
    files.push(...(await collectFiles(join(repositoryRoot, root))));
  }

  const serverOnlyImports = [
    "lib/env/server",
    "lib/env/boot",
    "config/server",
    "lib/logger/logger",
  ];

  for (const file of files) {
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) {
      continue;
    }

    const content = await readFile(file, "utf8");

    if (!content.includes('"use client"')) {
      continue;
    }

    const repositoryPath = toRepositoryPath(file);

    expect(
      !content.includes("process.env"),
      `${repositoryPath} is a client component and must not read process.env`,
    );

    for (const serverModule of serverOnlyImports) {
      expect(
        !content.includes(serverModule),
        `${repositoryPath} is a client component and must not import ${serverModule}`,
      );
    }
  }
}

function checkCatalogCopy() {
  const requiredShellKeys = [
    "skipToContent",
    "homeLink",
    "themeLabel",
    "themeSystem",
    "themeLight",
    "themeDark",
  ];
  const requiredErrorKeys = ["title", "description", "retry", "home", "referenceLabel"];

  for (const key of requiredShellKeys) {
    expect(
      typeof en.shell[key] === "string" && en.shell[key].length > 0,
      `the catalog must provide shell.${key}`,
    );
  }

  for (const key of requiredErrorKeys) {
    expect(
      typeof en.errorScreen[key] === "string" && en.errorScreen[key].length > 0,
      `the catalog must provide errorScreen.${key}`,
    );
  }
}

async function main() {
  checkThemeAgreement();
  checkCatalogCopy();

  await checkTokenDiscipline();
  await checkLayoutContract();
  await checkThemeConsumers();
  await checkErrorScreens();
  await checkClientBoundary();

  if (failures.length > 0) {
    process.stderr.write(`shell gate failed with ${failures.length} problem(s):\n`);
    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `shell gate passed: ${checkCount} checks, ${fileCount} files scanned, ` +
      `no colour literal, no palette step, theme script and provider agree\n`,
  );
}

await main();
