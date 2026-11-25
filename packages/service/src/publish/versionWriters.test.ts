import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  installIn,
  insertProductVersion,
  lockInstallation,
  LockedInstallation,
  lockProductVersions,
  moveToNewest,
  NewProductVersion,
  switchToCopy,
  VersionsLock,
} from './install.ts';
import type { PublishMode } from './publishOntology.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

type Table = 'ontologies' | 'product_versions';

function tableOf(name: string, constants: ReadonlyMap<string, Table>): Table | undefined {
  const bare = name.replaceAll(/["'`${}()]/g, '').toLowerCase();

  if (bare.endsWith('product_versions')) return 'product_versions';

  if (bare.endsWith('ontologies')) return 'ontologies';

  return constants.get(name.replaceAll(/[${}]/g, ''));
}

function withoutComments(text: string): string {
  return text.replaceAll(/\/\*[^]*?\*\//g, '').replaceAll(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function tableConstants(texts: ReadonlyMap<string, string>): Map<string, Table> {
  const constants = new Map<string, Table>();

  for (const text of texts.values()) {
    for (const [, name = '', value = ''] of text.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*([`'"][^;\n]*)/g,
    )) {
      const table = /product_versions/i.test(value)
        ? 'product_versions'
        : /\bontologies\b/i.test(value)
          ? 'ontologies'
          : undefined;

      if (table) constants.set(name, table);
    }
  }

  for (const text of texts.values()) {
    for (const [, from = '', to = ''] of text.matchAll(/\b([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g)) {
      const table = constants.get(from);

      if (table) constants.set(to, table);
    }
  }

  return constants;
}

interface RegistryWrite {
  readonly table: Table;
  readonly version: boolean;
}

function registryWrites(texts: ReadonlyMap<string, string>): Map<string, RegistryWrite[]> {
  const constants = tableConstants(texts);
  const writes = new Map<string, RegistryWrite[]>();

  for (const [path, source] of texts) {
    const text = withoutComments(source);

    for (const match of text.matchAll(
      /\b(?:INSERT\s+INTO|UPDATE)\b[\s'"`+]*(?:ONLY\s+)?((?:\$\{[^}]*\}|[\w$."])+)/gi,
    )) {
      const table = tableOf(match[1] ?? '', constants);

      if (!table) continue;

      const after = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 400);
      const statement = after.split(/\bvalues\s*:/)[0] ?? '';
      const version = /\bversion\b/i.test(statement) || /quoteName\(\s*['"`]version['"`]\s*\)/i.test(statement);

      writes.set(path, [...(writes.get(path) ?? []), { table, version: table === 'product_versions' || version }]);
    }
  }

  return writes;
}

function versionWriters(texts: ReadonlyMap<string, string>): string[] {
  return [...registryWrites(texts)].filter(([, writes]) => writes.some((write) => write.version)).map(([path]) => path);
}

const REGISTRY_WRITERS: Readonly<Record<string, string>> = {
  'packages/service/src/publish/install.ts': 'It is the 1 writer of a version.',
  'packages/service/src/publish/remap.ts': 'The remap writes the organization of a registry row.',
  'packages/service/src/db/engineChanges.ts': 'The engine-change catch-up writes engine_change_count.',
};

function sourceFiles(): Map<string, string> {
  const texts = new Map<string, string>();

  for (const folder of ['packages/service/src', 'tools']) {
    for (const path of readdirSync(join(ROOT, folder), { recursive: true, encoding: 'utf8' })) {
      if (!path.endsWith('.ts') || /\.(test|test-utils|fixture)\.ts$/.test(path) || path.includes('node_modules'))
        continue;

      const full = join(ROOT, folder, path);

      texts.set(relative(ROOT, full), readFileSync(full, 'utf8'));
    }
  }

  return texts;
}

describe('the 1 writer of a version', () => {
  it('service/code-layout#seams: only publish/install.ts writes a version, also for the switch of a restore, and only the listed files write a registry table', () => {
    const texts = sourceFiles();

    expect(versionWriters(texts)).toEqual(['packages/service/src/publish/install.ts']);
    expect([...registryWrites(texts).keys()].filter((path) => !(path in REGISTRY_WRITERS))).toEqual([]);
  });

  it('service/code-layout#seams: the source test finds each form of a probe file that writes a version, in any quoting and case', () => {
    const probes: readonly [string, string][] = [
      ['update.ts', 'await tx.query({ text: `update ONTOLOGY_REGISTRY.Ontologies SET Version = 3 WHERE rid = $1` });'],
      [
        'template.ts',
        'await tx.query({ text: `UPDATE ${ONTOLOGIES} o SET object_schema = $2, VERSION = $3 WHERE o.rid = $1` });',
      ],
      ['insert.ts', 'await tx.query({ text: `insert into ${PRODUCT_VERSIONS} (product, version) VALUES ($1, 2)` });'],
      [
        'registry.ts',
        'await tx.query({ text: `Insert Into ontology_registry.ontologies (rid, Version) VALUES ($1, 1)` });',
      ],
      [
        'quoted.ts',
        'await tx.query({ text: `UPDATE "ontology_registry"."ontologies" SET "version" = $1`, values: [3] });',
      ],
      [
        'quoteName.ts',
        "await tx.query({ text: `UPDATE ${ONTOLOGIES} SET ${quoteName('version')} = $1`, values: [3] });",
      ],
      [
        'concatInsert.ts',
        "await tx.query({ text: 'INSERT INTO ' + PRODUCT_VERSIONS + ' (product, version) VALUES ($1, 2)', values: [] });",
      ],
      ['concatUpdate.ts', "await tx.query({ text: `UPDATE ${ONTOLOGIES} SET ` + 'version = $1', values: [3] });"],
      [
        'otherInsert.ts',
        'const VERSIONS_TABLE = `${REGISTRY_SCHEMA}.product_versions`;\nawait tx.query({ text: `INSERT INTO ${VERSIONS_TABLE} (product, version) VALUES ($1, 2)`, values: [] });',
      ],
      [
        'otherUpdate.ts',
        "const REGISTRY = 'ontology_registry.ontologies';\nawait tx.query({ text: `UPDATE ${REGISTRY} SET version = $1`, values: [3] });",
      ],
      [
        'row.ts',
        'await tx.query({ text: `UPDATE ${ONTOLOGIES} SET (version, engine_change_count) = ($1, $2)`, values: [3, 1] });',
      ],
      [
        'upper.ts',
        'await tx.query({ text: `UPDATE ONTOLOGY_REGISTRY.ONTOLOGIES SET (VERSION, ENGINE_CHANGE_COUNT) = (7, 1)` });',
      ],
      [
        'renamed.ts',
        "import { PRODUCT_VERSIONS as PV } from './versions.ts';\nawait tx.query({ text: `INSERT INTO ${PV} (product) VALUES ($1)`, values: [] });",
      ],
      [
        'schemaUpdate.ts',
        "import { REGISTRY_SCHEMA } from '../db/index.ts';\nawait db.query({ text: `UPDATE ${REGISTRY_SCHEMA}.ontologies SET version = $1 WHERE rid = $2`, values: [version, rid] });",
      ],
      [
        'schemaInsert.ts',
        'await db.query({ text: `INSERT INTO ${REGISTRY_SCHEMA}.product_versions (product, version) VALUES ($1, 2)`, values: [] });',
      ],
      [
        'quoteNames.ts',
        "await db.query({ text: `UPDATE ${quoteName(REGISTRY_SCHEMA)}.${quoteName('ontologies')} SET version = $1`, values: [3] });",
      ],
      [
        'only.ts',
        'await db.query({ text: `UPDATE ONLY ontology_registry.ontologies SET version = $1`, values: [3] });',
      ],
    ];

    const texts = sourceFiles();

    for (const [name, text] of probes) {
      const path = `packages/service/src/publish/${name}`;

      expect([name, versionWriters(new Map([...texts, [path, text]])).includes(path)]).toEqual([name, true]);
    }

    const commented = 'packages/service/src/publish/commented.ts';

    const comments =
      '// Update rows of the page.\n/* This may update ontologies that a restore left on an older version. */\nexport const page = 1;';

    expect(registryWrites(new Map([...texts, [commented, comments]])).has(commented)).toBe(false);

    const count = 'packages/service/src/publish/count.ts';

    const counting = new Map([
      ...texts,
      [
        count,
        'await tx.query({ text: `UPDATE ${ONTOLOGIES} SET engine_change_count = $1 WHERE rid = $2`, values: [1, rid] });',
      ],
    ]);

    expect([versionWriters(counting).includes(count), [...registryWrites(counting).keys()].includes(count)]).toEqual([
      false,
      true,
    ]);
  });

  it('service/code-layout#seams: each write needs a lock value that only install.ts makes, and no write takes a version number', () => {
    expectTypeOf<Parameters<typeof insertProductVersion>[1]>().toEqualTypeOf<VersionsLock>();

    expectTypeOf<Parameters<typeof installIn>[1]>().toEqualTypeOf<VersionsLock>();

    expectTypeOf<Parameters<typeof moveToNewest>[1]>().toEqualTypeOf<LockedInstallation>();

    expectTypeOf<Parameters<typeof switchToCopy>[1]>().toEqualTypeOf<LockedInstallation>();

    expectTypeOf<{ readonly locked: true }>().not.toExtend<VersionsLock>();

    expectTypeOf<{ readonly rid: string; readonly version: number }>().not.toExtend<LockedInstallation>();

    type Writes = [
      ...Parameters<typeof insertProductVersion>,
      ...Parameters<typeof installIn>,
      ...Parameters<typeof moveToNewest>,
      ...Parameters<typeof switchToCopy>,
      ...Parameters<typeof lockProductVersions>,
      ...Parameters<typeof lockInstallation>,
    ];

    expectTypeOf<Extract<Writes[number], number>>().toBeNever();

    expectTypeOf<NewProductVersion>().not.toHaveProperty('version');
  });
});

const CHAIN_CALL = /\brunChain\s*\(/i;

function chainCallers(texts: ReadonlyMap<string, string>): string[] {
  return [...texts].filter(([, text]) => CHAIN_CALL.test(text)).map(([path]) => path);
}

describe('the 1 chain of steps', () => {
  it('service/publish#upgrade: publish and restore call the 1 chain of publish/upgrade.ts, and no other file calls it', () => {
    expect(chainCallers(sourceFiles())).toEqual([
      'packages/service/src/publish/publishOntology.ts',
      'packages/service/src/publish/restore.ts',
      'packages/service/src/publish/upgrade.ts',
    ]);
  });

  it('service/publish#upgrade: the text test finds a call of the chain in any case', () => {
    const probes = new Map([
      ['lower.ts', 'await runChain(tx, row, state);'],
      ['upper.ts', 'await RUNCHAIN (tx, row, state);'],
      ['other.ts', 'await runChainOf(tx, row);'],
    ]);

    expect(chainCallers(probes)).toEqual(['lower.ts', 'upper.ts']);
  });
});

describe('the mode of a publish', () => {
  it('service/code-layout#seams: a check carries a scope, and the type of the mode refuses an apply that carries one', () => {
    const check: PublishMode = { kind: 'check', scope: { organization: 'org_1' } };
    // @ts-expect-error An apply carries no scope.
    const apply: PublishMode = { kind: 'apply', scope: 'product' };
    const wide = { kind: 'apply' as const, scope: { organization: 'org_1' } };
    // @ts-expect-error An apply carries no scope, also through a variable.
    const fromVariable: PublishMode = wide;
    // @ts-expect-error An apply carries no scope, also through a spread.
    const fromSpread: PublishMode = { ...wide };

    expect([check.kind, apply.kind, fromVariable.kind, fromSpread.kind]).toEqual(['check', 'apply', 'apply', 'apply']);

    expectTypeOf<Extract<PublishMode, { kind: 'apply' }>['scope']>().toEqualTypeOf<undefined>();
  });
});

const PUBLISH_TESTS = 'packages/service/src/publish';

const WITHOUT_CHECK: Readonly<Record<string, string>> = {
  [`${PUBLISH_TESTS}/coldStartCheck.sql.test.ts`]:
    'It writes registry rows on an older version with SQL, to test the cold-start check.',
  [`${PUBLISH_TESTS}/refusals.sql.test.ts`]:
    'It records a refusal on an installation that is below the newest version, and on a version that SQL stores.',
  [`${PUBLISH_TESTS}/upgrade.sql.test.ts`]:
    'It stores versions with SQL, and runs the chain of a restore on a row below the newest version.',
  'packages/service/src/publish/permissions.sql.test.ts':
    'It leaves an installation on an older version on purpose, to test the cut of each product version.',
  'packages/service/src/permissionCatalog.sql.test.ts':
    'It leaves an installation on an older version on purpose, to test the catalog of each product version.',
};

describe('the end of each publish and install SQL test', () => {
  it('service/publish#applying: each publish and install SQL test ends with a check that no installation is below the newest version', () => {
    const files = [
      ...new Set([
        ...readdirSync(join(ROOT, PUBLISH_TESTS))
          .filter((name) => name.endsWith('.sql.test.ts') && name !== 'remapEntry.sql.test.ts')
          .map((name) => join(PUBLISH_TESTS, name)),
        'packages/service/src/db/engineChanges.sql.test.ts',
        'packages/service/src/db/linkPlan.sql.test.ts',
        'packages/service/src/db/tableChanges.sql.test.ts',
        'packages/service/src/organizations.sql.test.ts',
        'packages/service/src/db/ontologyEngineChanges.sql.test.ts',
        'packages/cli/src/publish.sql.test.ts',
        'packages/cli/src/publishBranchHead.sql.test.ts',
        'packages/service/src/publish/permissions.sql.test.ts',
        'packages/service/src/permissionCatalog.sql.test.ts',
        'tools/ops/restore-ontology-chain.sql.test.ts',
        'tools/ops/restore-ontology-copy.sql.test.ts',
        'tools/ops/restore-ontology-drop.sql.test.ts',
        'tools/ops/restore-ontology-switch.sql.test.ts',
      ]),
    ];

    expect(files.length).toBeGreaterThanOrEqual(36);

    const missing = files.filter(
      (file) =>
        !/^afterEach\([^]*?expectAllOnNewest\(/m.test(readFileSync(join(ROOT, file), 'utf8')) &&
        !(file in WITHOUT_CHECK),
    );

    expect(missing).toEqual([]);
    expect(Object.keys(WITHOUT_CHECK).filter((file) => !files.includes(file))).toEqual([]);
  });
});
