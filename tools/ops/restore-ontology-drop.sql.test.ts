import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ontologyEngineChanges } from '../../packages/service/src/db/index.ts';
import {
  dropSchema,
  expectAllOnNewest,
  sql,
  switchInstallation,
  waitForLockWaits,
} from '../../packages/service/src/publish/publish.test-utils.ts';
import {
  BEHIND,
  changedDatabase,
  createRestoreHarness,
  CURRENT,
  FROM_BEHIND,
  holdRowLock,
  INSTALLED_AFTER_RESTORE,
  line,
  LINE_BEHIND,
  NEW_ENGINE,
  NEW_OBJECTS,
  ORPHAN,
  PASSWORD,
  recording,
  row,
  runScript,
  schemaExists,
  STAMP,
  state,
  taskRows,
  UNKNOWN,
  WRITE,
  type Run,
} from './restore-ontology.test-utils.ts';

const h = createRestoreHarness('drop');
const ENGINE_CHANGE_COUNT = ontologyEngineChanges({ object: '', engine: '' }).length;

beforeAll(() => h.beforeAll());

afterAll(() => h.afterAll());

beforeEach(() => h.beforeEach());

afterEach(async () => {
  try {
    for (const db of h.productions()) await expectAllOnNewest(db);
  } finally {
    await h.cleanup();
  }
});

describe('restore guards', () => {
  it.each([
    [
      'service/storage#restore O1: a source version that production does not have',
      async () =>
        void (await h
          .direct()
          .query(sql("DELETE FROM ontology_registry.product_versions WHERE product = 'twin' AND version = 1"))),
      'Production has no version 1 of the product twin, so restore switches nothing.',
    ],
    [
      'service/storage#restore O2: a source row with another number',
      async () => {
        await h.source().query(sql('DELETE FROM ontology_registry.ontologies WHERE rid = $1', BEHIND));

        await h.source().query(
          sql(
            `INSERT INTO ontology_registry.ontologies (number, rid, api_name, display_name, object_schema, engine_schema, product, version, organization, engine_change_count)
             OVERRIDING SYSTEM VALUE VALUES (5, $1, 'twin1', 'twin1', 'ontology_1_objects', 'ontology_1_engine', 'twin', 1, 'org_1', $2)`,
            BEHIND,
            ENGINE_CHANGE_COUNT,
          ),
        );
      },
      'The source row has the number 5, and the live row has the number 1, so restore switches nothing.',
    ],
    [
      'service/storage#restore O3: a live Object schema that another role owns',
      () => h.asAdminIn(h.directUrl(), `ALTER SCHEMA ontology_1_objects OWNER TO ${h.otherOwner}`),
      `The role ${h.role} of the production connection does not own the Object schema ontology_1_objects of the live row, which ${h.otherOwner} owns, so restore switches nothing.`,
    ],
  ])(
    'default %s makes restore exit 1 before any write, with 1 line, also in a dry run',
    async (_name, change, message) => {
      await change();

      const before = [await state(h.direct()), await state(h.source())];

      for (const args of [['restore', BEHIND], WRITE]) {
        const result = await h.run(args);

        expect(result).toEqual({ code: 1, stdout: [], stderr: [message] });
      }

      expect([await state(h.direct()), await state(h.source())]).toEqual(before);
    },
  );

  it.each([
    [
      'service/storage#restore O1: the version of the source row is gone',
      (client: pg.Client) =>
        client.query("DELETE FROM ontology_registry.product_versions WHERE product = 'twin' AND version = 1"),
      `Production has no version 1 of the product twin, so restore switches nothing. The copy left the schemas ${NEW_OBJECTS} and ${NEW_ENGINE}.`,
    ],
    [
      'service/storage#restore O3: another role owns the live Object schema',
      (client: pg.Client) => client.query(`ALTER SCHEMA ontology_1_objects OWNER TO ${h.otherOwner}`),
      `The role ${h.role} of the production connection does not own the Object schema ontology_1_objects of the live row, which ${h.otherOwner} owns, so restore switches nothing. The copy left the schemas ${NEW_OBJECTS} and ${NEW_ENGINE}.`,
    ],
  ])(
    'default %s while the switch waits for the row lock: under the lock the switch exits 1 with 1 line that names both new schemas, which exist, and changes nothing (service/storage#restore)',
    async (_name, change, message) => {
      const before = await row(h.direct(), BEHIND);

      const admin = new pg.Client({ connectionString: changedDatabase(h.postgresUrl(), h.directUrl()) });

      await admin.connect();

      await admin.query('BEGIN');

      await admin.query('SELECT 1 FROM ontology_registry.ontologies WHERE rid = $1 FOR UPDATE', [BEHIND]);

      const restoring = h.run(WRITE);

      await waitForLockWaits(h.direct(), 1);

      await change(admin);

      await admin.query('COMMIT');

      await admin.end();

      const result = await restoring;

      expect(result).toEqual({ code: 1, stdout: [], stderr: [message] });

      expect(await row(h.direct(), BEHIND)).toEqual(before);

      expect([await schemaExists(h.direct(), NEW_OBJECTS), await schemaExists(h.direct(), NEW_ENGINE)]).toEqual([
        true,
        true,
      ]);
    },
  );

  it.each([
    [
      'a cold start of a later release raises the count of the live row',
      (client: pg.Client) =>
        client.query('UPDATE ontology_registry.ontologies SET engine_change_count = 4 WHERE rid = $1', [BEHIND]),
      'The production row has 4 per-Ontology engine changes, and this checkout lists 3.',
      { engine_change_count: 4 },
    ],
    [
      'a cold start of a later release adds a shared engine change',
      (client: pg.Client) =>
        client.query("INSERT INTO ontology_registry.engine_changes (id) VALUES ('0099-later-release')"),
      'Production has the shared engine change 0099-later-release, which this checkout does not list.',
      {},
    ],
  ])(
    'service/storage#restore: %s while the switch waits for the row lock: under the lock the switch exits 1, names the difference and both new schemas, and switches nothing',
    async (_name, change, difference, changed) => {
      const before = await row(h.direct(), BEHIND);

      const holder = await holdRowLock(h.directUrl(), BEHIND);

      const restoring = h.run(WRITE);

      await waitForLockWaits(h.direct(), 1);

      await change(holder.client);

      await holder.end();

      const result = await restoring;

      expect(result).toEqual({
        code: 1,
        stdout: [],
        stderr: [
          `The engine changes differ from this checkout, so restore switches nothing. ${difference} Run restore again with the checkout of the release that made the change. The copy left the schemas ${NEW_OBJECTS} and ${NEW_ENGINE}.`,
        ],
      });

      expect(await row(h.direct(), BEHIND)).toEqual({ ...before, ...changed });

      expect([await schemaExists(h.direct(), NEW_OBJECTS), await schemaExists(h.direct(), NEW_ENGINE)]).toEqual([
        true,
        true,
      ]);
    },
  );

  it('default service/storage#restore O2: a switch with a source row of another number exits 1 under the lock with 1 line, and changes nothing', async () => {
    await h.direct().query(sql(`CREATE SCHEMA ${NEW_OBJECTS}; CREATE SCHEMA ${NEW_ENGINE};`));

    const before = await row(h.direct(), BEHIND);

    let refusal: unknown;

    await h.direct().transaction(async (tx) => {
      refusal = await switchInstallation(tx, {
        rid: BEHIND,
        schemas: { object: NEW_OBJECTS, engine: NEW_ENGINE },
        source: { number: 5, version: 1, engineChangeCount: 3 },
      });
    });

    expect(refusal).toBe(
      'The source row has the number 5, and the live row has the number 1, so restore switches nothing.',
    );

    expect(await row(h.direct(), BEHIND)).toEqual(before);
  });

  it('service/storage#restore: a source version that only another product has makes restore exit 1, and write nothing', async () => {
    await h.direct().query(
      sql(`INSERT INTO ontology_registry.product_versions (product, version, ir, metadata, schema_migrations, osdk_set, functions, publisher)
           VALUES ('other', 7, '{}', '{}', '{"migrations": []}', '{}', NULL, 'test')`),
    );

    await h.source().query(sql('UPDATE ontology_registry.ontologies SET version = 7 WHERE rid = $1', BEHIND));

    const before = [await state(h.direct()), await state(h.source())];

    for (const args of [['restore', BEHIND], WRITE]) {
      expect(await h.run(args)).toEqual({
        code: 1,
        stdout: [],
        stderr: ['Production has no version 7 of the product twin, so restore switches nothing.'],
      });
    }

    expect([await state(h.direct()), await state(h.source())]).toEqual(before);
  });

  it.each([
    [
      'a copy on the newest version',
      CURRENT,
      { objectSchema: 'ontology_2_objects', engineSchema: 'ontology_2_engine', version: 3, engineChangeCount: 3 },
      3,
    ],
    ['a copy that is 2 versions old', BEHIND, FROM_BEHIND, 1],
  ])(
    'service/storage#restore: a restore of %s switches only that row, to the newest version',
    async (_name, rid, from, copyVersion) => {
      const other = rid === BEHIND ? CURRENT : BEHIND;

      const otherRow = await row(h.direct(), other);

      const number = rid === BEHIND ? 1 : 2;

      const to = {
        objectSchema: `ontology_${number}_objects_${STAMP}`,
        engineSchema: `ontology_${number}_engine_${STAMP}`,
        version: 3,
        engineChangeCount: 3,
      };

      const result = await h.run(['restore', rid, '--write', '--confirm-rid', rid]);

      expect(result.code).toBe(0);
      expect(line(result)).toEqual({ ontologyRid: rid, from, to, copyVersion, orphans: [] });

      expect(await row(h.direct(), rid)).toMatchObject({
        object_schema: to.objectSchema,
        engine_schema: to.engineSchema,
        version: 3,
      });

      expect(await row(h.direct(), other)).toEqual(otherRow);
    },
  );

  it.each([
    ['a copy 2 versions old', BEHIND, 1, 1],
    ['a copy on the newest version', CURRENT, 2, 3],
  ])(
    'service/storage#restore: with a newest version whose OSDK set this release does not list, the line of %s names the newest version as the failed version',
    async (_name, rid, number, copyVersion) => {
      await h.direct().query(sql("UPDATE ontology_registry.product_versions SET osdk_set = '{}' WHERE version = 3"));

      const before = await row(h.direct(), rid);

      expect(await h.run(['restore', rid, '--write', '--confirm-rid', rid])).toEqual({
        code: 1,
        stdout: [],
        stderr: [
          `The upgrade from version ${copyVersion} failed at version 3 on "check" with OntologyService:OntologyVersionNotSupported, so the row did not switch. ` +
            `The copy left the schemas ontology_${number}_objects_${STAMP} and ontology_${number}_engine_${STAMP}.`,
        ],
      });

      expect(await row(h.direct(), rid)).toEqual(before);
    },
  );

  it('service/storage#restore: a copy version that this release cannot compile fails the chain, and the line names the version of the copy as the failed version', async () => {
    await h.direct().query(sql("UPDATE ontology_registry.product_versions SET ir = '{}' WHERE version = 1"));

    const before = await row(h.direct(), BEHIND);

    const result = await h.run(WRITE);

    expect(result).toEqual({
      code: 1,
      stdout: [],
      stderr: [
        'The upgrade from version 1 failed at version 1 on "compile" with Default:InvalidArgument, so the row did not switch. ' +
          `The copy left the schemas ${NEW_OBJECTS} and ${NEW_ENGINE}.`,
      ],
    });

    expect(await row(h.direct(), BEHIND)).toEqual(before);
  });

  it('service/storage#restore: a source row behind the per-Ontology list gets each missing engine change in the new schemas, the count of the release, and the newest version', async () => {
    await h.source().query(sql('DROP TABLE ontology_1_engine.edit_history'));

    await h
      .source()
      .query(sql('UPDATE ontology_registry.ontologies SET engine_change_count = 1 WHERE rid = $1', BEHIND));

    const result = await h.run(WRITE);

    expect(result.code).toBe(0);
    expect(line(result)).toEqual(LINE_BEHIND);

    expect(await row(h.direct(), BEHIND)).toMatchObject({
      engine_schema: NEW_ENGINE,
      version: 3,
      engine_change_count: 3,
    });

    const [table] = await h.direct().query(sql('SELECT to_regclass($1)::text AS name', `${NEW_ENGINE}.edit_history`));

    expect(table).toEqual({ name: `${NEW_ENGINE}.edit_history` });
  });

  it.each([
    ['an unknown flag', ['restore', BEHIND, '--force'], /^Unknown option '--force'\. .* Usage: /],
    ['no RID', ['restore'], /^Usage: /],
    ['an unknown command', ['repair', BEHIND], /^Usage: /],
    [
      '--write alone',
      ['restore', BEHIND, '--write'],
      /^A write needs both --write and --confirm-rid ri\.ontology\.main\.ontology\.1\.$/,
    ],
    [
      '--confirm-rid alone',
      ['restore', BEHIND, '--confirm-rid', BEHIND],
      /^A write needs both --write and --confirm-rid ri\.ontology\.main\.ontology\.1\.$/,
    ],
    [
      'another --confirm-rid',
      ['restore', BEHIND, '--write', '--confirm-rid', CURRENT],
      /^--confirm-rid ri\.ontology\.main\.ontology\.2 is not the RID of the command, ri\.ontology\.main\.ontology\.1\.$/,
    ],
    [
      '--confirm-rid given 2 times',
      ['restore', BEHIND, '--write', '--confirm-rid', BEHIND, '--confirm-rid', BEHIND],
      /^The flag --confirm-rid is given 2 times\. Usage: /,
    ],
    [
      '--write alone before the command',
      ['--write', 'restore', BEHIND],
      /^A write needs both --write and --confirm-rid ri\.ontology\.main\.ontology\.1\.$/,
    ],
    [
      '--confirm-schema',
      ['restore', BEHIND, '--write', '--confirm-schema', BEHIND],
      /^The flag --confirm-schema is not a flag of restore\. Usage: /,
    ],
    [
      '--confirm-schema before the command',
      ['--write', '--confirm-schema', BEHIND, 'restore', BEHIND],
      /^The flag --confirm-schema is not a flag of restore\. Usage: /,
    ],
    [
      'an unknown RID in production',
      ['restore', UNKNOWN, '--write', '--confirm-rid', UNKNOWN],
      /^No installation has the RID ri\.ontology\.main\.ontology\.9 in production\.$/,
    ],
    [
      'an unknown RID in the source branch',
      ['restore', INSTALLED_AFTER_RESTORE, '--write', '--confirm-rid', INSTALLED_AFTER_RESTORE],
      /^No installation has the RID ri\.ontology\.main\.ontology\.7 in the source branch\.$/,
    ],
    [
      'an unknown RID in the source branch in a dry run',
      ['restore', INSTALLED_AFTER_RESTORE],
      /^No installation has the RID ri\.ontology\.main\.ontology\.7 in the source branch\.$/,
    ],
  ])(
    'service/storage#restore: %s exits 1 with 1 refusal on stderr and nothing on stdout, and writes nothing',
    async (_name, args, message) => {
      await h.direct().query(
        sql(
          `INSERT INTO ontology_registry.ontologies (number, rid, api_name, display_name, object_schema, engine_schema, product, version, organization, engine_change_count)
         OVERRIDING SYSTEM VALUE VALUES (7, $1, 'twin7', 'twin7', 'ontology_7_objects', 'ontology_7_engine', 'twin', 3, 'org_1', $2)`,
          INSTALLED_AFTER_RESTORE,
          ENGINE_CHANGE_COUNT,
        ),
      );

      const before = [await state(h.direct()), await state(h.source())];

      const result = await h.run(args);

      expect(result.code).toBe(1);
      expect(result.stdout).toEqual([]);
      expect(result.stderr).toHaveLength(1);
      expect(result.stderr[0]).toMatch(message);
      expect(result.stderr[0]).not.toContain('\n');

      expect([await state(h.direct()), await state(h.source())]).toEqual(before);
    },
  );

  it('service/storage#restore: a plan read that fails after both connections open exits 1 with the error code, and names no connection', async () => {
    const empty = await h.newDatabase('empty', { empty: true });

    const result = await h.run(
      ['restore', BEHIND],
      {},
      { DATABASE_URL_DIRECT: empty.url, RESTORE_SOURCE_URL: empty.url },
    );

    expect(result).toEqual({ code: 1, stdout: [], stderr: ['The command failed with the error code 42P01.'] });
  });

  it('service/storage#restore: a new-name schema that a registry row names makes restore exit 1, name it, and write nothing', async () => {
    expect((await h.run(WRITE)).code).toBe(0);

    const before = [await state(h.direct()), await state(h.source())];

    const result = await h.run(WRITE);

    expect(result.code).toBe(1);
    expect(result.stdout).toEqual([]);

    expect(result.stderr).toEqual([
      `A registry row names the new schema ${NEW_ENGINE} and ${NEW_OBJECTS}, so the copy writes nothing.`,
    ]);

    expect([await state(h.direct()), await state(h.source())]).toEqual(before);
  });

  it('service/storage#restore: 1 new-name schema that another registry row names makes restore exit 1, name it, and write nothing', async () => {
    await h.direct().query(sql(`CREATE SCHEMA ${NEW_OBJECTS}`));

    await h
      .direct()
      .query(sql('UPDATE ontology_registry.ontologies SET object_schema = $2 WHERE rid = $1', CURRENT, NEW_OBJECTS));

    const before = [await state(h.direct()), await state(h.source())];

    const result = await h.run(WRITE);

    expect(result.code).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([`A registry row names the new schema ${NEW_OBJECTS}, so the copy writes nothing.`]);

    expect([await state(h.direct()), await state(h.source())]).toEqual(before);
  });

  it.each([
    [
      'a shared change in production that the checkout does not list',
      () => h.direct().query(sql("INSERT INTO ontology_registry.engine_changes (id) VALUES ('0099-later-release')")),
      'The engine changes differ from this checkout. Production has the shared engine change 0099-later-release, which this checkout does not list.',
    ],
    [
      'a shared change of the checkout that production does not have',
      () => h.direct().query(sql("DELETE FROM ontology_registry.engine_changes WHERE id = '0006-installation-hold'")),
      'The engine changes differ from this checkout. Production does not have the shared engine change 0006-installation-hold of this checkout.',
    ],
    [
      'a production row count below the per-Ontology list',
      () =>
        h.direct().query(sql('UPDATE ontology_registry.ontologies SET engine_change_count = 1 WHERE rid = $1', BEHIND)),
      'The engine changes differ from this checkout. The production row has 1 per-Ontology engine changes, and this checkout lists 3.',
    ],
    [
      'a production row count above the per-Ontology list',
      () =>
        h.direct().query(sql('UPDATE ontology_registry.ontologies SET engine_change_count = 4 WHERE rid = $1', BEHIND)),
      'The engine changes differ from this checkout. The production row has 4 per-Ontology engine changes, and this checkout lists 3.',
    ],
    [
      'a source row count above the per-Ontology list',
      () =>
        h.source().query(sql('UPDATE ontology_registry.ontologies SET engine_change_count = 4 WHERE rid = $1', BEHIND)),
      'The engine changes differ from this checkout. The source row has 4 per-Ontology engine changes, above the 3 of this checkout.',
    ],
  ])(
    'service/storage#restore: %s makes restore exit 1, name the difference, and write nothing',
    async (_name, change, message) => {
      await change();

      const before = [await state(h.direct()), await state(h.source())];

      for (const args of [['restore', BEHIND], WRITE]) {
        const result = await h.run(args);

        expect(result.code).toBe(1);
        expect(result.stdout).toEqual([]);
        expect(result.stderr).toEqual([message]);
      }

      expect([await state(h.direct()), await state(h.source())]).toEqual(before);
    },
  );
});

describe('the secrets of the restore script', () => {
  function changed(base: string, change: (address: URL) => void): string {
    const address = new URL(base);

    change(address);

    return address.toString();
  }

  const CASES: ReadonlyArray<readonly [string, (base: string) => string, string]> = [
    [
      'a URL that does not parse',
      () => `postgres://${h.role}:${PASSWORD}@localhost:notaport/restore`,
      'The command failed with the error code ERR_INVALID_URL. A database URL is not a URL.',
    ],
    [
      'a wrong password',
      (base) => changed(base, (address) => (address.password = 'wrong-marker-password')),
      'The command failed with the error code 28P01. The password or the role is wrong.',
    ],
    [
      'a wrong port',
      (base) => changed(base, (address) => (address.port = '1')),
      'The command failed with the error code ECONNREFUSED. No server listens on the host and port of the URL.',
    ],
    [
      'a wrong database',
      (base) => changed(base, (address) => (address.pathname = '/no_such_database')),
      'The command failed with the error code 3D000. The database of the URL does not exist.',
    ],
    [
      'a host with no SSL',
      (base) => changed(base, (address) => (address.hostname = '0.0.0.0')),
      'The command failed with no error code. The error class is Error. The server does not accept SSL. Use a TLS-enabled or direct PostgreSQL connection string.',
    ],
  ];

  const SIDES = {
    DATABASE_URL_DIRECT: 'The production connection failed.',
    RESTORE_SOURCE_URL: 'The source connection failed.',
  } as const;

  it.each(
    CASES.flatMap(([name, url, message]) =>
      (['DATABASE_URL_DIRECT', 'RESTORE_SOURCE_URL'] as const).map(
        (variable) => [`${name} in ${variable}`, variable, url, message] as const,
      ),
    ),
  )(
    'service/storage#restore: %s exits 1 with 1 line on stderr that names the side, holds no URL and no password, and writes nothing',
    async (_name, variable, url, message) => {
      const env = { ...h.env(), [variable]: url(variable === 'DATABASE_URL_DIRECT' ? h.directUrl() : h.sourceUrl()) };

      const before = [await state(h.direct()), await state(h.source())];

      const result = await runScript(env, ...WRITE);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(`${SIDES[variable]} ${message}\n`);

      for (const secret of [PASSWORD, 'wrong-marker-password', 'postgres://'])
        expect(`${result.stdout}${result.stderr}`).not.toContain(secret);

      expect([await state(h.direct()), await state(h.source())]).toEqual(before);
    },
  );

  it.each(CASES)(
    'service/storage#restore: drop with %s in DATABASE_URL_DIRECT exits 1 with 1 line on stderr that holds no URL and no password',
    async (_name, url, message) => {
      await h.direct().query(sql(`CREATE SCHEMA ${ORPHAN}`));

      const result = await runScript(
        { DATABASE_URL_DIRECT: url(h.directUrl()) },
        'drop',
        ORPHAN,
        '--write',
        '--confirm-schema',
        ORPHAN,
      );

      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(`${message}\n`);

      for (const secret of [PASSWORD, 'wrong-marker-password', 'postgres://'])
        expect(`${result.stdout}${result.stderr}`).not.toContain(secret);

      expect(await schemaExists(h.direct(), ORPHAN)).toBe(true);
    },
  );
});

describe('drop', () => {
  const DROP = ['drop', ORPHAN, '--write', '--confirm-schema', ORPHAN];

  it('service/storage#restore: a real deadlock in drop ends like a lock wait: the line with PublishLockTimeout, exit 1, and the schema stays', async () => {
    await h.direct().query(sql(`CREATE SCHEMA ${ORPHAN}; CREATE TABLE ${ORPHAN}.t (x integer);`));

    const holder = new pg.Client({ connectionString: h.directUrl() });

    await holder.connect();

    await holder.query('BEGIN');

    await holder.query(`SELECT * FROM ${ORPHAN}.t`);

    const dropping = h.run(DROP);

    await waitForLockWaits(h.direct(), 1);

    const holderWait = holder.query('SELECT 1 FROM ontology_registry.ontologies WHERE number = 1 FOR UPDATE');

    const result = await dropping;

    await holderWait;

    await holder.query('COMMIT');

    await holder.end();

    expect(result).toEqual({
      code: 1,
      stdout: [`{"schema":"${ORPHAN}","dropped":false,"errorName":"PublishLockTimeout"}`],
      stderr: [],
    });

    expect(await schemaExists(h.direct(), ORPHAN)).toBe(true);
  });

  it('service/storage#restore: after a write, a dry run of drop of an old schema prints dropped false and drops nothing; a write prints dropped true and drops it', async () => {
    expect((await h.run(WRITE)).code).toBe(0);

    const dry = await h.run(['drop', 'ontology_1_objects']);

    expect(dry.code).toBe(0);
    expect(dry.stdout).toEqual(['{"schema":"ontology_1_objects","dropped":false}']);
    expect(dry.stderr).toEqual([]);

    expect(await schemaExists(h.direct(), 'ontology_1_objects')).toBe(true);

    const write = await h.run(['drop', 'ontology_1_objects', '--write', '--confirm-schema', 'ontology_1_objects']);

    expect(write.code).toBe(0);
    expect(write.stdout).toEqual(['{"schema":"ontology_1_objects","dropped":true}']);
    expect(write.stderr).toEqual([]);

    expect(await schemaExists(h.direct(), 'ontology_1_objects')).toBe(false);

    expect(await schemaExists(h.direct(), 'ontology_1_engine')).toBe(true);

    expect(await taskRows(h.direct(), NEW_OBJECTS)).toEqual(await taskRows(h.source(), 'ontology_1_objects'));
  });

  it('service/storage#restore: a drop of an orphan with the script, as an operator runs it, prints dropped true', async () => {
    await h.direct().query(sql(`CREATE SCHEMA ${ORPHAN}`));

    const result = await runScript({ DATABASE_URL_DIRECT: h.directUrl() }, ...DROP);

    expect(result).toEqual({ code: 0, stdout: `{"schema":"${ORPHAN}","dropped":true}\n`, stderr: '' });

    expect(await schemaExists(h.direct(), ORPHAN)).toBe(false);
  });

  it('service/storage#restore: drop of a schema that does not exist exits 1 with 1 line on stderr that names it, and writes nothing', async () => {
    const before = await state(h.direct());

    for (const args of [['drop', ORPHAN], DROP]) {
      const result = await h.run(args);

      expect(result.code).toBe(1);
      expect(result.stdout).toEqual([]);
      expect(result.stderr).toEqual([`The schema ${ORPHAN} does not exist, so drop drops nothing.`]);
    }

    expect(await state(h.direct())).toEqual(before);
  });

  it.each([
    ['an unknown flag', ['drop', ORPHAN, '--force'], /^Unknown option '--force'\. .* Usage: /],
    [
      '--confirm-rid',
      ['drop', ORPHAN, '--write', '--confirm-rid', ORPHAN],
      /^The flag --confirm-rid is not a flag of drop\. Usage: /,
    ],
    [
      '--confirm-rid before the command',
      ['--write', '--confirm-rid', ORPHAN, 'drop', ORPHAN],
      /^The flag --confirm-rid is not a flag of drop\. Usage: /,
    ],
    [
      '--write alone before the command',
      ['--write', 'drop', ORPHAN],
      /^A write needs both --write and --confirm-schema ontology_1_objects_20200101000000\.$/,
    ],
    [
      'another --confirm-schema before the command',
      ['--write', '--confirm-schema', 'ontology_1_engine', 'drop', ORPHAN],
      /^--confirm-schema ontology_1_engine is not the schema of the command, ontology_1_objects_20200101000000\.$/,
    ],
    ['no schema', ['drop'], /^Usage: /],
    [
      '--write alone',
      ['drop', ORPHAN, '--write'],
      /^A write needs both --write and --confirm-schema ontology_1_objects_20200101000000\.$/,
    ],
    [
      '--confirm-schema alone',
      ['drop', ORPHAN, '--confirm-schema', ORPHAN],
      /^A write needs both --write and --confirm-schema ontology_1_objects_20200101000000\.$/,
    ],
    [
      'another --confirm-schema',
      ['drop', ORPHAN, '--write', '--confirm-schema', 'ontology_1_engine'],
      /^--confirm-schema ontology_1_engine is not the schema of the command, ontology_1_objects_20200101000000\.$/,
    ],
    [
      '--confirm-schema given 2 times',
      ['drop', ORPHAN, '--write', '--confirm-schema', ORPHAN, '--confirm-schema', ORPHAN],
      /^The flag --confirm-schema is given 2 times\. Usage: /,
    ],
  ])(
    'service/storage#restore: %s exits 1 with 1 refusal on stderr, and drops nothing',
    async (_name, args, message) => {
      await h.direct().query(sql(`CREATE SCHEMA ${ORPHAN}`));

      const before = await state(h.direct());

      const result = await h.run(args);

      expect(result.code).toBe(1);
      expect(result.stdout).toEqual([]);
      expect(result.stderr).toHaveLength(1);
      expect(result.stderr[0]).toMatch(message);
      expect(result.stderr[0]).not.toContain('\n');

      expect(await state(h.direct())).toEqual(before);
    },
  );

  it.each([
    ['the flags before the command', ['--write', '--confirm-schema', ORPHAN, 'drop', ORPHAN]],
    ['the flags between the command and the schema', ['drop', '--confirm-schema', ORPHAN, '--write', ORPHAN]],
  ])(
    'service/storage#restore: a write of drop with %s drops the schema as the command-first order does',
    async (_name, args) => {
      await h.direct().query(sql(`CREATE SCHEMA ${ORPHAN}`));

      const result = await h.run(args);

      expect(result).toEqual({ code: 0, stdout: [`{"schema":"${ORPHAN}","dropped":true}`], stderr: [] });

      expect(await schemaExists(h.direct(), ORPHAN)).toBe(false);
    },
  );

  it.each([
    [
      'a schema that a row names',
      'ontology_1_objects',
      `The registry row of ${BEHIND} names the schema ontology_1_objects, so drop drops nothing.`,
    ],
    [
      'an engine schema that a row names',
      'ontology_2_engine',
      `The registry row of ${CURRENT} names the schema ontology_2_engine, so drop drops nothing.`,
    ],
    [
      'ontology_registry',
      'ontology_registry',
      'The schema ontology_registry is not of the form ontology_<n>_objects or ontology_<n>_engine, with or without _<stamp>, so drop drops nothing.',
    ],
    [
      'public',
      'public',
      'The schema public is not of the form ontology_<n>_objects or ontology_<n>_engine, with or without _<stamp>, so drop drops nothing.',
    ],
    [
      'a stamp that is too short',
      'ontology_1_objects_2026',
      'The schema ontology_1_objects_2026 is not of the form ontology_<n>_objects or ontology_<n>_engine, with or without _<stamp>, so drop drops nothing.',
    ],
    [
      'another prefix',
      'my_ontology_1_objects',
      'The schema my_ontology_1_objects is not of the form ontology_<n>_objects or ontology_<n>_engine, with or without _<stamp>, so drop drops nothing.',
    ],
    [
      'another suffix',
      'ontology_1_objects_old',
      'The schema ontology_1_objects_old is not of the form ontology_<n>_objects or ontology_<n>_engine, with or without _<stamp>, so drop drops nothing.',
    ],
  ])(
    'service/storage#restore: drop of %s exits 1 with 1 line on stderr, and drops nothing',
    async (_name, schema, message) => {
      for (const name of ['ontology_1_objects_2026', 'ontology_1_objects_old', 'my_ontology_1_objects'])
        await h.direct().query(sql(`CREATE SCHEMA ${name}`));

      const before = await state(h.direct());

      for (const args of [
        ['drop', schema],
        ['drop', schema, '--write', '--confirm-schema', schema],
      ]) {
        const result = await h.run(args);

        expect(result.code).toBe(1);
        expect(result.stdout).toEqual([]);
        expect(result.stderr).toEqual([message]);
      }

      expect(await state(h.direct())).toEqual(before);

      expect(await schemaExists(h.direct(), schema)).toBe(true);
    },
  );

  it('service/storage#restore: a switch that holds the row lock of row 1 makes drop wait; when the switch commits and names the schema, the waiting drop refuses it', async () => {
    await h.direct().query(sql(`CREATE SCHEMA ${ORPHAN}; CREATE SCHEMA ontology_1_engine_20200101000000;`));

    let dropping: Promise<Run> | undefined;

    await h.direct().transaction(async (tx) => {
      const switched = await switchInstallation(tx, {
        rid: BEHIND,
        schemas: { object: ORPHAN, engine: 'ontology_1_engine_20200101000000' },
        source: { number: 1, version: 1, engineChangeCount: 3 },
      });

      expect(switched).toMatchObject({ from: { number: 1 }, to: { number: 1, version: 3 } });

      dropping = h.run(DROP);

      await waitForLockWaits(h.direct(), 1);
    });

    const result = await dropping;

    expect(result?.code).toBe(1);
    expect(result?.stdout).toEqual([]);

    expect(result?.stderr).toEqual([
      `The registry row of ${BEHIND} names the schema ${ORPHAN}, so drop drops nothing.`,
    ]);

    expect(await schemaExists(h.direct(), ORPHAN)).toBe(true);
  });

  it('service/storage#restore: when the lock wait of drop ends, it exits 1, prints the line with dropped false and PublishLockTimeout on stdout and nothing on stderr, and drops nothing', async () => {
    await h.direct().query(sql(`CREATE SCHEMA ${ORPHAN}`));

    const holder = await holdRowLock(h.directUrl(), BEHIND);

    let result;
    const order: string[] = [];

    try {
      result = await h.run(DROP, { lockTimeout: '1s' });

      order.push('timed-out');
    } finally {
      await holder.end();

      order.push('released');
    }

    expect(order).toEqual(['timed-out', 'released']);
    expect(result.code).toBe(1);
    expect(result.stdout).toEqual([`{"schema":"${ORPHAN}","dropped":false,"errorName":"PublishLockTimeout"}`]);
    expect(result.stderr).toEqual([]);

    expect(await schemaExists(h.direct(), ORPHAN)).toBe(true);

    expect((await h.run(DROP)).stdout).toEqual([`{"schema":"${ORPHAN}","dropped":true}`]);
  });

  it('service/storage#restore: drop locks the row of the number in its schema name, and no other row', async () => {
    const other = 'ontology_2_engine_20200101000000';

    await h.direct().query(sql(`CREATE SCHEMA ${ORPHAN}; CREATE SCHEMA ${other};`));

    const holder = await holdRowLock(h.directUrl(), CURRENT);

    try {
      expect((await h.run(DROP, { lockTimeout: '1s' })).stdout).toEqual([`{"schema":"${ORPHAN}","dropped":true}`]);

      const waited = await h.run(['drop', other, '--write', '--confirm-schema', other], { lockTimeout: '1s' });

      expect(waited.code).toBe(1);
      expect(waited.stdout).toEqual([`{"schema":"${other}","dropped":false,"errorName":"PublishLockTimeout"}`]);
    } finally {
      await holder.end();
    }

    expect(await schemaExists(h.direct(), other)).toBe(true);
  });

  it('service/storage#restore: drop sets lock_timeout 90s and statement_timeout 120s as their own statements, then locks the row of number 1 with FOR UPDATE, then checks and drops the schema', async () => {
    await h.direct().query(sql(`CREATE SCHEMA ${ORPHAN}`));

    const { statements, settings, db } = recording(h.direct());

    expect(await dropSchema(db, { schema: ORPHAN, write: true })).toEqual({ schema: ORPHAN, dropped: true });

    expect(settings).toEqual([{ lock_timeout: '90s', statement_timeout: '2min' }]);
    expect(statements[0]).toEqual({ text: "SELECT set_config('lock_timeout', $1, true)", values: ['90s'] });
    expect(statements[1]).toEqual({ text: "SELECT set_config('statement_timeout', '120s', true)", values: [] });

    expect(statements[2]).toEqual({
      text: 'SELECT 1 FROM ontology_registry.ontologies WHERE number = $1 FOR UPDATE',
      values: [1],
    });

    expect(statements.at(-1)).toEqual({ text: `DROP SCHEMA "${ORPHAN}" CASCADE`, values: [] });
  });
});
