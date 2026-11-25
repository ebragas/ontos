import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const service = fileURLToPath(new URL('../', import.meta.url));

let cachedTrackedFiles: string[] = [];
let cachedOtelTree: { readonly problems?: unknown } = {};
let cachedTscVersion = '';

beforeAll(() => {
  cachedTrackedFiles = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .filter((file) => Boolean(file) && existsSync(`${repo}${file}`));

  cachedOtelTree = JSON.parse(
    execFileSync('npm', ['ls', '@opentelemetry/api', '--json'], { cwd: repo, encoding: 'utf8' }),
  ) as { readonly problems?: unknown };

  cachedTscVersion = execFileSync(`${repo}node_modules/.bin/tsc`, ['-v'], { encoding: 'utf8' });
});

interface PackageJson {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

function dependencies(path: string): string[] {
  const json = JSON.parse(readFileSync(path, 'utf8')) as PackageJson;

  return [json.dependencies, json.devDependencies, json.peerDependencies, json.optionalDependencies].flatMap((deps) =>
    Object.keys(deps ?? {}),
  );
}

function trackedFiles(): string[] {
  return cachedTrackedFiles;
}

function serviceSources(): string[] {
  return readdirSync(`${service}src`, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !/\.(test|test-utils|fixture)\.ts$/.test(file))
    .map((file) => `src/${file}`);
}

describe('libraries', () => {
  it('service/code-layout#libraries: the Ontology service depends on no ORM and no query builder', () => {
    const builders = [
      'knex',
      'kysely',
      'drizzle-orm',
      'prisma',
      '@prisma/client',
      'typeorm',
      'sequelize',
      'objection',
      '@mikro-orm/core',
      'slonik',
      'pg-promise',
      'squel',
      'sql-bricks',
    ];

    const deps = [...dependencies(`${service}package.json`), ...dependencies(`${repo}package.json`)];

    expect(deps.filter((name) => builders.includes(name))).toEqual([]);
  });

  it('service/code-layout#libraries: the service depends on the 5 OpenTelemetry packages of the trace export, with no peer conflict', () => {
    const json = JSON.parse(readFileSync(`${service}package.json`, 'utf8')) as PackageJson;

    const otel = Object.fromEntries(
      Object.entries(json.dependencies ?? {}).filter(([name]) => name.startsWith('@opentelemetry/')),
    );

    expect(Object.keys(otel).sort()).toEqual([
      '@opentelemetry/api',
      '@opentelemetry/context-async-hooks',
      '@opentelemetry/exporter-trace-otlp-proto',
      '@opentelemetry/resources',
      '@opentelemetry/sdk-trace',
    ]);

    expect(otel['@opentelemetry/api']).toMatch(/^1\.10\.\d+$/);
    expect(otel['@opentelemetry/sdk-trace']).toMatch(/^3\.\d+\.\d+$/);

    expect(cachedOtelTree.problems).toBeUndefined();
  });
});

describe('third-party code', () => {
  it('service/code-layout#osdk-code: the repo holds no patched or forked third-party file', () => {
    const files = trackedFiles();

    expect(files.filter((file) => /(^|\/)(patches|vendor|vendored)\//.test(file) || file.endsWith('.patch'))).toEqual(
      [],
    );

    expect(files.filter((file) => file.startsWith('LICENSES/'))).toEqual([]);

    const code = files.filter((file) => /^(packages|tools)\/.*\.(ts|js|mjs|cjs)$/.test(file));
    const header = /Copyright \d{4} /;

    expect(code.filter((file) => header.test(readFileSync(`${repo}${file}`, 'utf8')))).toEqual([]);

    const manifests = files.filter((file) => file.endsWith('package.json'));

    expect(manifests.filter((file) => dependencies(`${repo}${file}`).includes('patch-package'))).toEqual([]);
  });
});

describe('Ontology service', () => {
  it('service/ontology-service#contract: the Ontology service does not depend on or import @osdk/maker', () => {
    expect(dependencies(`${service}package.json`).filter((name) => name.startsWith('@osdk/maker'))).toEqual([]);

    const importers = serviceSources().filter((file) =>
      /from\s+['"]@osdk\/maker|import\(\s*['"]@osdk\/maker/.test(readFileSync(`${service}${file}`, 'utf8')),
    );

    expect(importers).toEqual([]);
  });

  it('service/ontology-service#contract: the root, CLI, and service packages require Node >=24, and .nvmrc names 24', () => {
    const engines = ['package.json', 'packages/cli/package.json', 'packages/service/package.json'].map(
      (path) => (JSON.parse(readFileSync(`${repo}${path}`, 'utf8')) as { engines: { node: string } }).engines.node,
    );

    expect(engines).toEqual(['>=24', '>=24', '>=24']);
    expect(readFileSync(`${repo}.nvmrc`, 'utf8').trim()).toBe('24');
  });
});

describe('TypeScript', () => {
  const ownOptions = (path: string): Record<string, unknown> =>
    (ts.readConfigFile(path, (file) => ts.sys.readFile(file)).config as { compilerOptions?: Record<string, unknown> })
      .compilerOptions ?? {};

  it('service/code-layout#typescript: packages/service/tsconfig.json sets the target and module of the base itself', () => {
    const base = ownOptions(`${repo}tsconfig.base.json`);
    const own = ownOptions(`${service}tsconfig.json`);

    expect({ target: own.target, module: own.module }).toEqual({ target: base.target, module: base.module });
  });

  it('service/code-layout#typescript: the root, CLI, and service packages pin the same exact TypeScript 6.0 version with no @typescript/native alias', () => {
    const manifest = (path: string): PackageJson => JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
    const rootDevDependencies = manifest(`${repo}package.json`).devDependencies ?? {};

    const pins = {
      root: rootDevDependencies.typescript,
      native: rootDevDependencies['@typescript/native'],
      cli: manifest(`${repo}packages/cli/package.json`).dependencies?.typescript,
      service: manifest(`${service}package.json`).devDependencies?.typescript,
    };

    const exact = /^6\.0\.\d+$/;

    expect(pins).toEqual({
      root: expect.stringMatching(exact),
      native: undefined,
      cli: pins.root,
      service: pins.root,
    });

    for (const folder of [repo, `${repo}packages/cli/`, service]) {
      const installed = createRequire(`${folder}package.json`)('typescript/package.json') as {
        name: string;
        version: string;
      };

      expect(installed).toMatchObject({ name: 'typescript', version: pins.root });
    }

    expect(cachedTscVersion).toMatch(/^Version 6\.0\./);
  });
});

describe('seams', () => {
  function moduleState(file: string): string[] {
    return moduleStateOf(file, readFileSync(`${service}${file}`, 'utf8'));
  }

  function moduleStateOf(file: string, text: string): string[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const found: string[] = [];

    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;

      const mutable =
        (statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== ts.NodeFlags.Const;

      for (const declaration of statement.declarationList.declarations) {
        const type = declaration.type?.getText(source) ?? '';
        const value = declaration.initializer?.getText(source) ?? '';

        const stateWords =
          /\b(Db|SnapshotDb|Pool|PoolClient|Client|Caller|CompiledOntology)\b|(\b|_)(version|user)|Version|User/;

        const container =
          /^new\s+(Weak)?(Map|Set)\b/.test(value) &&
          /\b(Db|SnapshotDb|Pool|PoolClient|Client|Caller)\b|User/.test(value);

        const keepsState = (mutable && stateWords.test(`${type} ${declaration.name.getText(source)}`)) || container;
        const opensClient = /\bcreate(Pool|Db)\(|new\s+pg\.(Pool|Client)\b|\.connect\(/.test(value);

        if (keepsState || opensClient) found.push(`${file}: ${declaration.getText(source)}`);
      }
    }

    return found;
  }

  it('the check finds a module-level database client, Caller, or version', () => {
    const text = [
      'let db: Db;',
      'let caller: Caller;',
      'let version: number;',
      'let currentVersion = 0;',
      'let currentUser;',
      'const callers = new Map<string, Caller>();',
      'const cache = new Map<number, CompiledOntology>();',
      'let useRouter = 1;',
      '',
    ].join('\n');

    expect(moduleStateOf('example.ts', text)).toEqual([
      'example.ts: db: Db',
      'example.ts: caller: Caller',
      'example.ts: version: number',
      'example.ts: currentVersion = 0',
      'example.ts: currentUser',
      'example.ts: callers = new Map<string, Caller>()',
    ]);
  });

  it('the node adapter makes its pools once, through inputFromEnv', () => {
    const node = readFileSync(`${service}src/node.ts`, 'utf8');

    expect(node.match(/createPool\b.*/g)).toEqual([
      "createPool } from './db/index.ts';",
      'createPool(connectionString);',
    ]);

    expect(node).toContain('inputFromEnv(process.env, (connectionString) => {');
  });

  it('service/code-layout#seams: no module keeps a database client, the current Ontology version, or the user at module scope, except the compiled Ontology cache', () => {
    const modules = serviceSources().filter((file) => file !== 'src/node.ts');

    expect(modules.length).toBeGreaterThan(10);
    expect(modules.flatMap(moduleState)).toEqual([]);
  });
});

describe('the column held', () => {
  const CODE = /^(packages\/service\/(src|api)|packages\/cli\/src|scripts\/(ops|deploy))\/.*\.ts$/;

  const ENGINE_CHANGE = {
    file: 'packages/service/src/db/engineChanges.ts',
    text: '.ontologies ADD COLUMN held boolean NOT NULL DEFAULT false;',
  };

  const SPAN_ATTRIBUTE = 'sql.held';

  function isPropertyName(node: ts.Identifier): boolean {
    const { parent } = node;

    if (ts.isBindingElement(parent))
      return ts.isObjectBindingPattern(parent.parent) && (parent.propertyName ?? parent.name) === node;

    return (
      (ts.isPropertyAccessExpression(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isShorthandPropertyAssignment(parent)) &&
      parent.name === node
    );
  }

  function heldNames(file: string, text: string): string[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const found: string[] = [];

    const visit = (node: ts.Node): void => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        if (
          /\bheld\b/i.test(node.text) &&
          node.text !== SPAN_ATTRIBUTE &&
          !(file === ENGINE_CHANGE.file && node.text === ENGINE_CHANGE.text)
        )
          found.push(`${file}: ${node.text}`);
      } else if (ts.isIdentifier(node) && node.text === 'held' && isPropertyName(node)) {
        found.push(`${file}: ${node.parent.getText(source)}`);
      }

      ts.forEachChild(node, visit);
    };

    visit(source);

    return found;
  }

  it('service/code-layout#seams: a probe file that reads or writes held fails the check, and the engine change 0006-installation-hold passes it', () => {
    const probe = [
      'const rows = await db.query<{ held: boolean }>({ text: `SELECT rid, held FROM ${ONTOLOGIES}`, values: [] });',
      "await db.query({ text: 'UPDATE ontology_registry.ontologies SET held = true', values: [] });",
      "await db.query({ text: 'SELECT rid FROM ontology_registry.ontologies WHERE NOT HELD', values: [] });",
      'const skipped = rows.filter((row) => row.held);',
      'const kept = rows.filter(({ held }) => !held);',
      'const { held: frozen } = rows[0];',
      'class Row { held = false; }',
      'for (const [role, held] of entries) use(role, held);',
      '',
    ].join('\n');

    expect(heldNames('packages/service/src/probe.ts', probe)).toEqual([
      'packages/service/src/probe.ts: held: boolean',
      'packages/service/src/probe.ts: SELECT rid, held FROM ',
      'packages/service/src/probe.ts: UPDATE ontology_registry.ontologies SET held = true',
      'packages/service/src/probe.ts: SELECT rid FROM ontology_registry.ontologies WHERE NOT HELD',
      'packages/service/src/probe.ts: row.held',
      'packages/service/src/probe.ts: held',
      'packages/service/src/probe.ts: held: frozen',
      'packages/service/src/probe.ts: held = false;',
    ]);

    const change =
      "sql: `ALTER TABLE ${REGISTRY_SCHEMA}.ontologies ADD COLUMN held boolean NOT NULL DEFAULT false;`,\nconst attributes = { 'sql.held': true };\n";

    expect(heldNames(ENGINE_CHANGE.file, change)).toEqual([]);

    expect(heldNames('packages/service/src/probe.ts', change)).toEqual([
      'packages/service/src/probe.ts: .ontologies ADD COLUMN held boolean NOT NULL DEFAULT false;',
    ]);
  });

  it('service/code-layout#seams: no code names the column held, except the engine change 0006-installation-hold', () => {
    const files = trackedFiles().filter((file) => CODE.test(file) && !/\.(test|test-utils|fixture)\.ts$/.test(file));

    expect(files).toContain(ENGINE_CHANGE.file);
    expect(files.flatMap((file) => heldNames(file, readFileSync(`${repo}${file}`, 'utf8')))).toEqual([]);
  });
});
