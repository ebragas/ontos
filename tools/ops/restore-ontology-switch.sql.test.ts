import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPool } from '../../packages/service/src/db/index.ts';
import { createDb } from '../../packages/service/src/db/promise.test-utils.ts';
import {
  expectAllOnNewest,
  readSettledRow,
  restoreSwitch,
  sql,
  waitForLockWaits,
} from '../../packages/service/src/publish/publish.test-utils.ts';
import {
  BEHIND,
  changedDatabase,
  createRestoreHarness,
  dropCommitReply,
  FROM_BEHIND,
  holdRowLock,
  line,
  NEW_ENGINE,
  NEW_OBJECTS,
  ORPHAN,
  PASSWORD,
  recording,
  row,
  schemaExists,
  state,
  SWITCH_UPDATE,
  taskRows,
  WRITE,
} from './restore-ontology.test-utils.ts';

const h = createRestoreHarness('switch');

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

describe('restore switch', () => {
  it.each([
    [
      'a constraint check',
      'ALTER TABLE ontology_1_objects.task ADD CONSTRAINT task_slow CHECK (ontology_registry.slow_check(task_id))',
    ],
    ['an index build', 'CREATE INDEX task_slow ON ontology_1_objects.task ((ontology_registry.slow_check(task_id)))'],
  ])(
    'service/storage#restore: %s of the copy that passes the copy limit exits 1 with 1 line, and leaves no new schema and no orphan',
    async (_name, slow) => {
      for (const db of [h.direct(), h.source()]) {
        await db.query(
          sql(
            "CREATE FUNCTION ontology_registry.slow_check(value text) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT pg_sleep(1) IS NOT NULL'",
          ),
        );
      }

      await h.source().query(sql(slow));

      const before = await state(h.direct());

      const result = await h.run(WRITE, { copyTimeout: '2s' });

      expect(result).toEqual({
        code: 1,
        stdout: [],
        stderr: [
          `The command failed with the error code 57014. The statement passed its time limit. Run the command again. The copy may have left the schemas ${NEW_OBJECTS} and ${NEW_ENGINE}.`,
        ],
      });

      expect(await state(h.direct())).toEqual(before);

      expect(await schemaExists(h.direct(), NEW_OBJECTS)).toBe(false);

      const next = await h.run(['restore', BEHIND], { now: new Date('2026-11-10T02:00:00Z') });

      expect(line(next)).toMatchObject({ orphans: [] });
    },
  );

  it('service/storage#restore: drop sets its own statement_timeout above its lock wait, so a role statement_timeout below the lock wait still ends in PublishLockTimeout', async () => {
    await h.direct().query(sql(`CREATE SCHEMA ${ORPHAN}`));

    await h.asAdmin(`ALTER DATABASE ${new URL(h.directUrl()).pathname.slice(1)} SET statement_timeout = '1s'`);

    const holder = await holdRowLock(h.directUrl(), BEHIND);

    let result;

    try {
      result = await h.run(['drop', ORPHAN, '--write', '--confirm-schema', ORPHAN], { lockTimeout: '2s' });
    } finally {
      await holder.end();
    }

    expect(result).toEqual({
      code: 1,
      stdout: [`{"schema":"${ORPHAN}","dropped":false,"errorName":"PublishLockTimeout"}`],
      stderr: [],
    });

    expect(await schemaExists(h.direct(), ORPHAN)).toBe(true);
  });

  it('service/storage#restore: a real deadlock in the switch, run through restoreSwitch because the plan reads of main also wait on product_versions, ends like a lock wait: the live row of 1 read with no lock, and no change', async () => {
    await h.direct().query(sql(`CREATE SCHEMA ${NEW_OBJECTS}; CREATE SCHEMA ${NEW_ENGINE};`));

    const before = await row(h.direct(), BEHIND);

    const adminUrl = changedDatabase(h.postgresUrl(), h.directUrl());
    const adminPool = createPool(adminUrl);

    h.trackPool(adminPool);

    const admin = createDb(adminPool);
    const holder = new pg.Client({ connectionString: adminUrl });

    await holder.connect();

    await holder.query("SET deadlock_timeout = '1h'");

    await holder.query('BEGIN');

    await holder.query('LOCK TABLE ontology_registry.product_versions IN ACCESS EXCLUSIVE MODE');

    const rowLock = await holdRowLock(h.directUrl(), BEHIND);

    const switching = restoreSwitch(h.direct(), {
      rid: BEHIND,
      schemas: { object: NEW_OBJECTS, engine: NEW_ENGINE },
      source: { number: 1, version: 1, engineChangeCount: 3 },
    });

    await waitForLockWaits(admin, 1);

    const holderWait = holder.query('SELECT 1 FROM ontology_registry.ontologies WHERE rid = $1 FOR UPDATE', [BEHIND]);

    await waitForLockWaits(admin, 2);

    await rowLock.end();

    const result = await switching;

    await holderWait;

    await holder.query('COMMIT');

    await holder.end();

    expect(result).toEqual({
      waitEnded: true,
      live: {
        number: 1,
        product: 'twin',
        schemas: { object: 'ontology_1_objects', engine: 'ontology_1_engine' },
        version: 3,
        engineChangeCount: 3,
      },
    });

    expect(await row(h.direct(), BEHIND)).toEqual(before);
  });

  it('service/storage#restore: after 2 restores, a third lists the stamped schemas that no row names in orphans, and switches; a run that stopped before its switch shows its 2 schemas in orphans of the next run', async () => {
    const at = (time: string) => ({ now: new Date(time) });

    await h
      .direct()
      .query(
        sql('CREATE SCHEMA ontology_2_objects_20200101000000; CREATE SCHEMA ontology_1_objects_20200101000000_copy;'),
      );

    expect((await h.run(WRITE, at('2026-11-10T01:00:00Z'))).code).toBe(0);

    expect((await h.run(WRITE, at('2026-11-10T02:00:00Z'))).code).toBe(0);

    const third = await h.run(WRITE, at('2026-11-10T03:00:00Z'));

    expect(third.code).toBe(0);

    expect(line(third)).toMatchObject({
      from: { objectSchema: 'ontology_1_objects_20261110020000', engineSchema: 'ontology_1_engine_20261110020000' },
      to: { objectSchema: 'ontology_1_objects_20261110030000', engineSchema: 'ontology_1_engine_20261110030000' },
      orphans: ['ontology_1_engine_20261110010000', 'ontology_1_objects_20261110010000'],
    });

    expect(await row(h.direct(), BEHIND)).toMatchObject({ object_schema: 'ontology_1_objects_20261110030000' });

    const holder = await holdRowLock(h.directUrl(), BEHIND);

    let stopped;

    try {
      stopped = await h.run(WRITE, { ...at('2026-11-10T04:00:00Z'), lockTimeout: '1s' });
    } finally {
      await holder.end();
    }

    const live = {
      objectSchema: 'ontology_1_objects_20261110030000',
      engineSchema: 'ontology_1_engine_20261110030000',
      version: 3,
      engineChangeCount: 3,
    };

    expect(stopped.code).toBe(1);

    expect(line(stopped)).toEqual({
      ontologyRid: BEHIND,
      from: live,
      to: live,
      copyVersion: 1,
      orphans: [
        'ontology_1_engine_20261110010000',
        'ontology_1_engine_20261110020000',
        'ontology_1_objects_20261110010000',
        'ontology_1_objects_20261110020000',
      ],
      left: ['ontology_1_objects_20261110040000', 'ontology_1_engine_20261110040000'],
      errorName: 'PublishLockTimeout',
    });

    expect(await row(h.direct(), BEHIND)).toMatchObject({ object_schema: 'ontology_1_objects_20261110030000' });

    const next = await h.run(['restore', BEHIND], at('2026-11-10T05:00:00Z'));

    expect(next.code).toBe(0);

    expect(line(next)).toMatchObject({
      orphans: [
        'ontology_1_engine_20261110010000',
        'ontology_1_engine_20261110020000',
        'ontology_1_engine_20261110040000',
        'ontology_1_objects_20261110010000',
        'ontology_1_objects_20261110020000',
        'ontology_1_objects_20261110040000',
      ],
    });
  });

  it('service/storage#restore: when the lock wait ends, the script exits 1, prints the line with PublishLockTimeout on stdout and nothing on stderr, and switches nothing', async () => {
    const before = await row(h.direct(), BEHIND);

    const holder = await holdRowLock(h.directUrl(), BEHIND);

    let result;
    const order: string[] = [];

    try {
      result = await h.run(WRITE, { lockTimeout: '1s' });

      order.push('timed-out');
    } finally {
      await holder.end();

      order.push('released');
    }

    expect(order).toEqual(['timed-out', 'released']);
    expect(result.code).toBe(1);

    expect(line(result)).toEqual({
      ontologyRid: BEHIND,
      from: FROM_BEHIND,
      to: FROM_BEHIND,
      copyVersion: 1,
      orphans: [],
      left: [NEW_OBJECTS, NEW_ENGINE],
      errorName: 'PublishLockTimeout',
    });

    expect(await schemaExists(h.direct(), NEW_OBJECTS)).toBe(true);

    expect(await schemaExists(h.direct(), NEW_ENGINE)).toBe(true);

    expect(await row(h.direct(), BEHIND)).toEqual(before);
  });

  it('service/storage#restore: a drop of 1 new schema between the copy and the switch makes the switch exit 1, name it, and leave the row as it was', async () => {
    const before = await row(h.direct(), BEHIND);

    const holder = await holdRowLock(h.directUrl(), BEHIND);

    const restoring = h.run(WRITE);

    await waitForLockWaits(h.direct(), 1);

    await holder.client.query(`DROP SCHEMA ${NEW_ENGINE} CASCADE`);

    await holder.end();

    const result = await restoring;

    expect(result.code).toBe(1);
    expect(result.stdout).toEqual([]);

    expect(result.stderr).toEqual([
      `The new schema ${NEW_ENGINE} does not exist, so the switch changed nothing. The copy left the schemas ${NEW_OBJECTS} and ${NEW_ENGINE}.`,
    ]);

    expect(await row(h.direct(), BEHIND)).toEqual(before);

    expect(await schemaExists(h.direct(), NEW_OBJECTS)).toBe(true);
  });

  it('service/storage#restore: an error of the switch that is not a lock wait exits 1, says the row did not switch, names both new schemas on its line, and both exist', async () => {
    await h.direct().query(
      sql(`CREATE FUNCTION ontology_registry.refuse_update() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'refused' USING ERRCODE = 'P0001'; END$$;
           CREATE TRIGGER refuse_update BEFORE UPDATE ON ontology_registry.ontologies FOR EACH ROW EXECUTE FUNCTION ontology_registry.refuse_update();`),
    );

    const before = await row(h.direct(), BEHIND);

    const result = await h.run(WRITE);

    expect(result).toEqual({
      code: 1,
      stdout: [],
      stderr: [
        `The command failed with the error code P0001. The row did not switch. The copy left the schemas ${NEW_OBJECTS} and ${NEW_ENGINE}.`,
      ],
    });

    expect(await row(h.direct(), BEHIND)).toEqual(before);

    expect([await schemaExists(h.direct(), NEW_OBJECTS), await schemaExists(h.direct(), NEW_ENGINE)]).toEqual([
      true,
      true,
    ]);
  });

  it('service/storage#restore: when the server commits the copy and the connection ends before the COMMIT reply, the line ends with both new schemas, which exist', async () => {
    const proxy = await dropCommitReply(h.directUrl(), 'CREATE SCHEMA');

    try {
      const before = await row(h.direct(), BEHIND);

      const result = await h.run(WRITE, {}, { DATABASE_URL_DIRECT: proxy.url, RESTORE_SOURCE_URL: h.sourceUrl() });

      expect(result).toMatchObject({ code: 1, stdout: [] });
      expect(result.stderr).toHaveLength(1);

      expect(result.stderr[0]).toMatch(
        new RegExp(` The copy may have left the schemas ${NEW_OBJECTS} and ${NEW_ENGINE}\\.$`),
      );

      expect(await row(h.direct(), BEHIND)).toEqual(before);

      expect([await schemaExists(h.direct(), NEW_OBJECTS), await schemaExists(h.direct(), NEW_ENGINE)]).toEqual([
        true,
        true,
      ]);
    } finally {
      await proxy.close();
    }
  });

  it('service/storage#restore: when the server commits the switch and the connection ends before the COMMIT reply, the line says the row switched, names the live schemas, and does not say the copy left them', async () => {
    const proxy = await dropCommitReply(h.directUrl(), SWITCH_UPDATE);

    try {
      const result = await h.run(WRITE, {}, { DATABASE_URL_DIRECT: proxy.url, RESTORE_SOURCE_URL: h.sourceUrl() });

      expect(await row(h.direct(), BEHIND)).toMatchObject({ object_schema: NEW_OBJECTS, engine_schema: NEW_ENGINE });

      expect(result).toMatchObject({ code: 1, stdout: [] });
      expect(result.stderr).toHaveLength(1);

      expect(result.stderr[0]).toMatch(
        new RegExp(` The row switched to the schemas ${NEW_OBJECTS} and ${NEW_ENGINE}\\.$`),
      );

      expect(result.stderr[0]).not.toContain('The copy left');
    } finally {
      await proxy.close();
    }
  });

  it('service/storage#restore: the read after an error of the switch waits for an open switch transaction, and reads the row after its commit', async () => {
    const holder = await holdRowLock(h.directUrl(), BEHIND);

    await holder.client.query(
      'UPDATE ontology_registry.ontologies SET object_schema = $2, engine_schema = $3 WHERE rid = $1',
      [BEHIND, NEW_OBJECTS, NEW_ENGINE],
    );

    const reading = readSettledRow(h.direct(), BEHIND);

    await waitForLockWaits(h.direct(), 1);

    await holder.end();

    expect((await reading)?.schemas).toEqual({ object: NEW_OBJECTS, engine: NEW_ENGINE });
  });

  it('service/storage#restore: when the switch reply is lost and the next connection fails too, the line says the row may have switched to the 2 new schemas', async () => {
    const proxy = await dropCommitReply(h.directUrl(), SWITCH_UPDATE, true);

    try {
      const result = await h.run(WRITE, {}, { DATABASE_URL_DIRECT: proxy.url, RESTORE_SOURCE_URL: h.sourceUrl() });

      expect(await row(h.direct(), BEHIND)).toMatchObject({ object_schema: NEW_OBJECTS, engine_schema: NEW_ENGINE });

      expect(result).toMatchObject({ code: 1, stdout: [] });
      expect(result.stderr).toHaveLength(1);

      expect(result.stderr[0]).toMatch(
        new RegExp(
          ` The script could not read the registry row, so the row may have switched to the schemas ${NEW_OBJECTS} and ${NEW_ENGINE}\\.$`,
        ),
      );

      expect(result.stderr[0]).not.toContain(proxy.url);
    } finally {
      await proxy.close();
    }
  });

  it('service/storage#restore: a request that starts during the copy reads the old schema names and the old rows', async () => {
    const oldRows = await taskRows(h.direct(), 'ontology_1_objects');

    const locker = new pg.Client({ connectionString: h.sourceUrl() });

    await locker.connect();

    await locker.query('BEGIN');

    await locker.query('LOCK TABLE ontology_1_objects.task IN ACCESS EXCLUSIVE MODE');

    let restoring;

    try {
      restoring = h.run(WRITE);

      await waitForLockWaits(h.source(), 1);

      const [names] = await h
        .direct()
        .query<{ object_schema: string; engine_schema: string }>(
          sql('SELECT object_schema, engine_schema FROM ontology_registry.ontologies WHERE rid = $1', BEHIND),
        );

      expect(names).toEqual({ object_schema: 'ontology_1_objects', engine_schema: 'ontology_1_engine' });

      expect(await taskRows(h.direct(), names?.object_schema ?? '')).toEqual(oldRows);

      expect(await schemaExists(h.direct(), NEW_OBJECTS)).toBe(false);
    } finally {
      await locker.query('COMMIT');

      await locker.end();
    }

    expect((await restoring).code).toBe(0);

    expect(await row(h.direct(), BEHIND)).toMatchObject({ object_schema: NEW_OBJECTS });
  });

  it('service/storage#restore: the switch sets lock_timeout 90s and statement_timeout 120s as their own statements, before the row lock with FOR UPDATE', async () => {
    await h.direct().query(sql(`CREATE SCHEMA ${NEW_OBJECTS}; CREATE SCHEMA ${NEW_ENGINE};`));

    const { statements, settings, db } = recording(h.direct());

    expect(
      await restoreSwitch(db, {
        rid: BEHIND,
        schemas: { object: NEW_OBJECTS, engine: NEW_ENGINE },
        source: { number: 1, version: 1, engineChangeCount: 3 },
      }),
    ).toMatchObject({
      from: { version: 3 },
      to: { version: 3 },
    });

    expect(settings).toEqual([{ lock_timeout: '90s', statement_timeout: '2min' }]);
    expect(statements[0]).toEqual({ text: "SELECT set_config('lock_timeout', $1, true)", values: ['90s'] });
    expect(statements[1]).toEqual({ text: "SELECT set_config('statement_timeout', '120s', true)", values: [] });

    expect(statements[2]?.text.replace(/\s+/g, ' ')).toMatch(
      /^SELECT .* FROM ontology_registry\.ontologies WHERE rid = \$1 FOR UPDATE$/,
    );
  });

  it('service/storage#restore service/publish#upgrade: the switch takes no lock of the product versions, reads the newest version after the row lock, and its chain of 2 steps runs no set_config', async () => {
    await h.direct().query(sql(`CREATE SCHEMA ${NEW_OBJECTS}; CREATE SCHEMA ${NEW_ENGINE};`));

    const { statements, db } = recording(h.direct());

    expect(
      await restoreSwitch(db, {
        rid: BEHIND,
        schemas: { object: NEW_OBJECTS, engine: NEW_ENGINE },
        source: { number: 1, version: 1, engineChangeCount: 3 },
      }),
    ).toMatchObject({
      to: { version: 3 },
    });

    const texts = statements.map((statement) => statement.text.replace(/\s+/g, ' '));

    const rowLock = texts.findIndex((text) =>
      /FROM ontology_registry\.ontologies WHERE rid = \$1 FOR UPDATE$/.test(text),
    );

    const newest = texts.findIndex((text) =>
      /max\(version\).* FROM ontology_registry\.product_versions WHERE product = \$1$/i.test(text),
    );

    expect([rowLock, newest > rowLock]).toEqual([2, true]);
    expect(texts.filter((text) => /\bLOCK\b.*product_versions/i.test(text))).toEqual([]);
    expect(texts.flatMap((text, at) => (/set_config/i.test(text) ? [at] : []))).toEqual([0, 1]);

    expect(
      texts.filter((text) =>
        /FROM ontology_registry\.product_versions WHERE product = \$1 AND version = \$2$/i.test(text),
      ).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('service/storage#restore: an error inside the copy transaction, after both connections worked, exits 1 with 1 line on stderr with no side word, no URL, and no password, and writes nothing', async () => {
    await h.direct().query(sql(`CREATE SCHEMA ${NEW_OBJECTS}`));

    const before = await state(h.direct());

    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');
    let result;
    let written: string[];

    try {
      result = await h.run(WRITE);

      written = [...out.mock.calls, ...err.mock.calls].map(([chunk]) => String(chunk));
    } finally {
      out.mockRestore();

      err.mockRestore();
    }

    expect(result.code).toBe(1);
    expect(result.stdout).toEqual([]);

    expect(result.stderr).toEqual([
      `The command failed with the error code 42P06. The copy may have left the schemas ${NEW_OBJECTS} and ${NEW_ENGINE}.`,
    ]);

    expect(`${written.join('')}${result.stderr.join('')}`).not.toContain(PASSWORD);
    expect(`${written.join('')}${result.stderr.join('')}`).not.toContain('postgres://');

    expect(await state(h.direct())).toEqual(before);
  });
});
