// path: scripts/verify-structure.mjs
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = join(repositoryRoot, "config", "structure.json");
const skippedDirectories = new Set([
  "node_modules",
  ".next",
  ".git",
  "out",
  "build",
  "dist",
  "coverage",
  ".turbo",
  ".vercel",
  ".netlify",
]);

const failures = [];

function toRepositoryPath(absolutePath) {
  return relative(repositoryRoot, absolutePath).split(sep).join("/");
}

function recordFailure(message) {
  failures.push(message);
}

async function pathExists(absolutePath) {
  try {
    await stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function loadManifest() {
  const rawManifest = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(rawManifest);

  if (!Array.isArray(manifest.directories) || manifest.directories.length === 0) {
    throw new Error("config/structure.json must list at least one directory");
  }
  if (!Array.isArray(manifest.rootFiles) || manifest.rootFiles.length === 0) {
    throw new Error("config/structure.json must list at least one root file");
  }
  if (!Array.isArray(manifest.sourceRoots) || manifest.sourceRoots.length === 0) {
    throw new Error("config/structure.json must list at least one source root");
  }

  return manifest;
}

async function verifyDirectories(manifest) {
  for (const entry of manifest.directories) {
    const absolutePath = join(repositoryRoot, entry.path);
    if (!(await pathExists(absolutePath))) {
      recordFailure(`missing directory: ${entry.path}`);
      continue;
    }
    const entryStat = await stat(absolutePath);
    if (!entryStat.isDirectory()) {
      recordFailure(`expected a directory but found a file: ${entry.path}`);
    }
  }
}

async function verifyRootFiles(manifest) {
  for (const rootFile of manifest.rootFiles) {
    if (!(await pathExists(join(repositoryRoot, rootFile)))) {
      recordFailure(`missing root file: ${rootFile}`);
    }
  }
}

async function collectSourceFiles(directoryPath, sourceExtensions, collected) {
  const entries = await readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      if (skippedDirectories.has(entry.name)) {
        continue;
      }
      await collectSourceFiles(absolutePath, sourceExtensions, collected);
      continue;
    }

    if (entry.isFile() && sourceExtensions.some((extension) => entry.name.endsWith(extension))) {
      collected.push(absolutePath);
    }
  }
}

function expectedPathComment(repositoryPath, extension) {
  if (extension === ".css") {
    return `/* path: ${repositoryPath} */`;
  }
  return `// path: ${repositoryPath}`;
}

function extensionOf(fileName) {
  const lastDotIndex = fileName.lastIndexOf(".");
  return lastDotIndex === -1 ? "" : fileName.slice(lastDotIndex);
}

async function verifySourceFile(absolutePath, manifest) {
  const repositoryPath = toRepositoryPath(absolutePath);
  const content = await readFile(absolutePath, "utf8");

  if (content.trim().length === 0) {
    recordFailure(`empty source file: ${repositoryPath}`);
    return;
  }

  const expectedComment = expectedPathComment(repositoryPath, extensionOf(repositoryPath));
  const firstLine = content.split("\n", 1)[0].trim();

  if (firstLine !== expectedComment) {
    recordFailure(
      `path comment mismatch in ${repositoryPath}: expected "${expectedComment}" on the first line, found "${firstLine}"`,
    );
  }

  for (const marker of manifest.forbiddenMarkers) {
    if (content.includes(marker)) {
      recordFailure(`forbidden marker "${marker}" found in ${repositoryPath}`);
    }
  }
}

async function verifySources(manifest) {
  const collected = [];

  for (const sourceRoot of manifest.sourceRoots) {
    const absolutePath = join(repositoryRoot, sourceRoot);
    if (!(await pathExists(absolutePath))) {
      recordFailure(`missing source root: ${sourceRoot}`);
      continue;
    }
    await collectSourceFiles(absolutePath, manifest.sourceExtensions, collected);
  }

  collected.sort();
  for (const absolutePath of collected) {
    await verifySourceFile(absolutePath, manifest);
  }

  return collected.length;
}

async function main() {
  const manifest = await loadManifest();

  await verifyDirectories(manifest);
  await verifyRootFiles(manifest);
  const sourceFileCount = await verifySources(manifest);

  if (failures.length > 0) {
    process.stderr.write(`structure gate failed with ${failures.length} problem(s):\n`);
    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `structure gate passed: ${manifest.directories.length} directories, ` +
      `${manifest.rootFiles.length} root files, ${sourceFileCount} source files checked\n`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`structure gate crashed: ${message}\n`);
  process.exitCode = 1;
});
