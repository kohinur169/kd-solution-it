// path: migrations/verify.ts
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Migrations gate. Run with `npm run check:migrations`, and inside `npm run verify`.
 *
 * A migration is the one artefact in this repository that cannot be corrected after it is
 * applied: the rules make them append only, so a mistake becomes a second migration and a data
 * repair. This gate therefore reads every file and refuses the shapes that turn a mistake into an
 * incident:
 *
 *   1. numbering: four digits, contiguous from 0001, no duplicate number;
 *   2. pairing: every forward file has its `.down.sql`, and every rollback has its forward;
 *   3. shape: the path comment on line one, `begin;` first and `commit;` last, ASCII only;
 *   4. append-only: a forward file never drops, truncates or deletes;
 *   5. tenancy: every created table has id, company_id, created_at, updated_at, deleted_at and
 *      version, and the id default is the shared UUID v7 function;
 *   6. security: every created table enables row level security and carries its default-deny
 *      policy in the same file, refusing reads and writes alike;
 *   7. rollback: a down file drops exactly the tables its forward file creates;
 *   8. no revision: a table is created once, and no file adds a column the table already has. This
 *      is the shape a duplicate looks like - a `create table` that repeats an earlier one, or an
 *      `alter table ... add column` for a column some earlier file already wrote - and it only
 *      fails when the SQL is applied, which is the one thing this static gate cannot do. STEP 053
 *      shipped exactly that mistake (`0091` added `sessions.reauthenticated_at`, which `0010`
 *      already had) and this check is why it cannot happen again.
 *
 * The gate is static, so it runs anywhere a Node.js process runs. Whether the SQL actually
 * applies is proven by running it against PostgreSQL; that transcript belongs to the handoff file
 * of the STEP that added the migration.
 */

const migrationsDirectory = fileURLToPath(new URL("./", import.meta.url));
const forwardPattern = /^(\d{4})_[a-z][a-z0-9_]*\.sql$/u;
const downPattern = /^(\d{4})_[a-z][a-z0-9_]*\.down\.sql$/u;
const requiredColumns: readonly string[] = [
  "id",
  "company_id",
  "created_at",
  "updated_at",
  "deleted_at",
  "version",
];
const forbiddenMarkers: readonly string[] = ["TODO", "FIXME", "XXX"];
const appendOnlyBreaches: readonly RegExp[] = [
  /\bdrop\s+table\b/iu,
  /\btruncate\b/iu,
  /\bdelete\s+from\b/iu,
];
const nonAsciiPattern = /[^\u0009\u000a\u000d\u0020-\u007e]/u;
const defaultDenyPattern =
  /create policy \w+_default_deny\b[^;]*using \(false\)[^;]*with check \(false\);/u;
const columnPattern =
  /^([a-z_][a-z0-9_]*)\s+(uuid|text|boolean|integer|bigint|smallint|numeric|jsonb|json|timestamptz|date|interval|bytea|character|varchar|double precision)\b/u;

interface TableDefinition {
  readonly name: string;
  readonly columns: readonly string[];
  readonly idClause: string;
}

interface MigrationFile {
  readonly name: string;
  readonly number: number;
  readonly content: string;
  readonly tables: readonly TableDefinition[];
}

const failures: string[] = [];
let checkCount = 0;

function expect(condition: boolean, description: string): void {
  checkCount += 1;

  if (!condition) {
    failures.push(description);
  }
}

function statementsOf(content: string): readonly string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("--"));
}

function parseTables(content: string): readonly TableDefinition[] {
  const pattern = /create\s+table\s+(?:public\.)?([a-z][a-z0-9_]*)\s*\(([\s\S]*?)\n\);/giu;
  const tables: TableDefinition[] = [];
  let match = pattern.exec(content);

  while (match !== null) {
    const name = match[1] ?? "";
    const body = match[2] ?? "";
    const lines = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("constraint"));
    // A column line starts with its name and a type; the body of a long constraint does not, so
    // this keeps the words of a wrapped check from being read as columns of the table.
    const columns = lines
      .map((line) => columnPattern.exec(line)?.[1])
      .filter((column): column is string => column !== undefined);
    const idLine = lines.find((line) => line.startsWith("id ")) ?? "";

    tables.push({ name, columns, idClause: idLine });
    match = pattern.exec(content);
  }

  return tables;
}

async function readMigrationFiles(): Promise<
  { forward: MigrationFile[]; down: Map<number, MigrationFile>; names: string[] }
> {
  const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
  const forward: MigrationFile[] = [];
  const down = new Map<number, MigrationFile>();

  for (const name of names) {
    const content = await readFile(`${migrationsDirectory}${name}`, "utf8");
    const downMatch = downPattern.exec(name);

    if (downMatch !== null) {
      down.set(Number(downMatch[1]), { name, number: Number(downMatch[1]), content, tables: [] });
      continue;
    }

    const forwardMatch = forwardPattern.exec(name);

    expect(forwardMatch !== null, `migration file name is not NNNN_lower_snake.sql: ${name}`);

    if (forwardMatch !== null) {
      forward.push({
        name,
        number: Number(forwardMatch[1]),
        content,
        tables: parseTables(content),
      });
    }
  }

  return { forward, down, names };
}

function checkNumbering(forward: readonly MigrationFile[]): void {
  const numbers = forward.map((file) => file.number).sort((left, right) => left - right);

  numbers.forEach((number, index) => {
    expect(
      number === index + 1,
      `migration numbering must be contiguous from 0001: expected ${String(index + 1).padStart(4, "0")}, found ${String(number).padStart(4, "0")}`,
    );
  });

  const duplicates = numbers.filter((number, index) => numbers.indexOf(number) !== index);

  expect(duplicates.length === 0, `duplicate migration number(s): ${duplicates.join(", ")}`);
}

function checkForwardFile(file: MigrationFile): void {
  const statements = statementsOf(file.content);
  const expectedComment = `-- path: migrations/${file.name}`;
  const firstLine = (file.content.split("\n", 1)[0] ?? "").trim();

  expect(firstLine === expectedComment, `${file.name}: first line must be "${expectedComment}"`);
  expect(!nonAsciiPattern.test(file.content), `${file.name}: must be ASCII only`);
  expect(statements.length > 2, `${file.name}: must contain more than a transaction wrapper`);
  expect(statements[0] === "begin;", `${file.name}: must start with begin;`);
  expect(statements[statements.length - 1] === "commit;", `${file.name}: must end with commit;`);

  for (const marker of forbiddenMarkers) {
    expect(!file.content.includes(marker), `${file.name}: forbidden marker "${marker}"`);
  }

  for (const breach of appendOnlyBreaches) {
    expect(!breach.test(file.content), `${file.name}: a forward migration never drops or deletes rows`);
  }

  for (const table of file.tables) {
    for (const column of requiredColumns) {
      expect(
        table.columns.includes(column),
        `${file.name}: table ${table.name} is missing the required column ${column}`,
      );
    }

    expect(
      table.idClause.includes("public.uuid_generate_v7()"),
      `${file.name}: table ${table.name} must default its id to public.uuid_generate_v7()`,
    );

    expect(
      file.content.includes(`alter table public.${table.name} enable row level security;`),
      `${file.name}: table ${table.name} must enable row level security in this file`,
    );

    expect(
      file.content.includes(`create policy ${table.name}_default_deny`),
      `${file.name}: table ${table.name} must carry its default-deny policy in this file`,
    );

    expect(
      defaultDenyPattern.test(file.content),
      `${file.name}: the default-deny policy of ${table.name} must refuse reads and writes`,
    );
  }
}

/**
 * Refuse a table created twice, and a column added to a table that already has it.
 *
 * The two are the same defect from a reader's side: a migration that reads as an addition and is
 * really a duplicate, so the chain applies on the machine that wrote it - where the SQL was never
 * run - and fails on the first real database. The scan is in file order, so "already has it" means
 * everything written before this file.
 */
function checkNoRevisions(forward: readonly MigrationFile[]): void {
  const columnsByTable = new Map<string, string>();
  const createdBy = new Map<string, string>();
  const addColumnPattern =
    /alter\s+table\s+(?:if\s+exists\s+)?public\.([a-z][a-z0-9_]*)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z][a-z0-9_]*)/giu;

  for (const file of forward) {
    for (const table of file.tables) {
      const already = createdBy.get(table.name);

      expect(
        already === undefined,
        `${file.name}: table ${table.name} is already created by ${already ?? "an earlier file"}`,
      );

      if (already === undefined) {
        createdBy.set(table.name, file.name);
      }

      columnsByTable.set(table.name, table.columns.join(" "));
    }
  }

  for (const file of forward) {
    addColumnPattern.lastIndex = 0;
    let match = addColumnPattern.exec(file.content);

    while (match !== null) {
      const table = match[1] ?? "";
      const column = match[2] ?? "";
      const known = columnsByTable.get(table) ?? "";

      expect(
        !known.split(" ").includes(column),
        `${file.name}: column ${table}.${column} already exists, so this file must not add it`,
      );

      columnsByTable.set(table, `${known} ${column}`.trim());
      match = addColumnPattern.exec(file.content);
    }
  }
}

function checkDownFile(file: MigrationFile, forward: MigrationFile): void {
  const statements = statementsOf(file.content);

  expect(
    (file.content.split("\n", 1)[0] ?? "").trim() === `-- path: migrations/${file.name}`,
    `${file.name}: first line must be the path comment`,
  );
  expect(!nonAsciiPattern.test(file.content), `${file.name}: must be ASCII only`);
  expect(statements[0] === "begin;", `${file.name}: must start with begin;`);
  expect(statements[statements.length - 1] === "commit;", `${file.name}: must end with commit;`);
  expect(
    !/create\s+table/iu.test(file.content),
    `${file.name}: a rollback never creates a table`,
  );

  for (const table of forward.tables) {
    expect(
      file.content.includes(`drop table if exists public.${table.name};`),
      `${file.name}: must drop table ${table.name}, which ${forward.name} creates`,
    );
  }
}

async function main(): Promise<void> {
  const { forward, down, names } = await readMigrationFiles();

  expect(forward.length > 0, "there must be at least one migration once STEP 012 runs");

  const sqlFileCount = names.filter(
    (name) => forwardPattern.test(name) || downPattern.test(name),
  ).length;

  expect(
    sqlFileCount === names.length,
    `every .sql file must follow the naming rule, found: ${names.join(", ")}`,
  );

  checkNumbering(forward);

  for (const file of forward) {
    checkForwardFile(file);

    const rollback = down.get(file.number);

    expect(rollback !== undefined, `${file.name}: has no rollback file`);

    if (rollback !== undefined) {
      checkDownFile(rollback, file);
    }
  }

  checkNoRevisions(forward);

  for (const rollback of down.values()) {
    expect(
      forward.some((file) => file.number === rollback.number),
      `${rollback.name}: has no forward migration`,
    );
  }

  if (failures.length > 0) {
    process.stderr.write(`migrations gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  const tableCount = forward.reduce((total, file) => total + file.tables.length, 0);

  process.stdout.write(
    `migrations gate passed: ${checkCount} checks, ${forward.length} migrations, ` +
      `${tableCount} tables, every forward file transactional and default-deny\n`,
  );
}

await main();
