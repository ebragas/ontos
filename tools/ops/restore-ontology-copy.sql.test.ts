import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../packages/service/src/db/promise.test-utils.ts';
import { expectAllOnNewest, sql, waitForLockWaits } from '../../packages/service/src/publish/publish.test-utils.ts';
import {
  BEHIND,
  catalog,
  columnsByRow,
  createRestoreHarness,
  CURRENT,
  line,
  LINE_BEHIND,
  NEW_ENGINE,
  NEW_OBJECTS,
  quote,
  row,
  state,
  taskRows,
  TO_BEHIND,
  WRITE,
} from './restore-ontology.test-utils.ts';

const h = createRestoreHarness('copy');

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

describe('restore copy', () => {
  it('service/storage#restore service/storage#schema-and-access: a dry run prints the literal JSON line with the stamp of the start time, copyVersion, and the newest version in to, and writes nothing in either database', async () => {
    const before = [await state(h.direct()), await state(h.source())];

    const result = await h.run(['restore', BEHIND]);

    expect(result.code).toBe(0);
    expect(line(result)).toEqual(LINE_BEHIND);

    expect(result.stdout[0]).toBe(
      `{"ontologyRid":"${BEHIND}","from":{"objectSchema":"ontology_1_objects","engineSchema":"ontology_1_engine","version":3,"engineChangeCount":3},` +
        `"to":{"objectSchema":"${NEW_OBJECTS}","engineSchema":"${NEW_ENGINE}","version":3,"engineChangeCount":3},"copyVersion":1,"orphans":[]}`,
    );

    expect([await state(h.direct()), await state(h.source())]).toEqual(before);
  });

  it('service/storage#restore service/storage#schema-and-access: a write prints the literal JSON line, and switches the row to the 2 stamped schemas and the newest version', async () => {
    const result = await h.run(WRITE);

    expect(result.code).toBe(0);

    expect(result.stdout).toEqual([
      `{"ontologyRid":"${BEHIND}","from":{"objectSchema":"ontology_1_objects","engineSchema":"ontology_1_engine","version":3,"engineChangeCount":3},` +
        `"to":{"objectSchema":"${NEW_OBJECTS}","engineSchema":"${NEW_ENGINE}","version":3,"engineChangeCount":3},"copyVersion":1,"orphans":[]}`,
    ]);

    expect(await row(h.direct(), BEHIND)).toEqual({
      number: 1,
      object_schema: 'ontology_1_objects_20261110010203',
      engine_schema: 'ontology_1_engine_20261110010203',
      product: 'twin',
      version: 3,
      engine_change_count: 3,
    });
  });

  it.each([
    ['the flags before the command', ['--write', '--confirm-rid', BEHIND, 'restore', BEHIND]],
    ['the flags between the command and the RID', ['restore', '--confirm-rid', BEHIND, '--write', BEHIND]],
  ])(
    'service/storage#restore: a write with %s switches the row as the command-first order does',
    async (_name, args) => {
      const result = await h.run(args);

      expect(result.code).toBe(0);
      expect(line(result)).toEqual(LINE_BEHIND);

      expect(await row(h.direct(), BEHIND)).toMatchObject({
        object_schema: NEW_OBJECTS,
        engine_schema: NEW_ENGINE,
        version: 3,
      });
    },
  );

  it('service/storage#restore: a round trip gives back the rows of the source; the other Ontology and the old schemas keep the rows of production', async () => {
    const otherRow = await row(h.direct(), CURRENT);

    const otherRows = await taskRows(h.direct(), 'ontology_2_objects');

    const oldRows = await taskRows(h.direct(), 'ontology_1_objects');

    await h
      .source()
      .query(
        sql(
          "INSERT INTO ontology_1_objects.task (task_id, title) SELECT 'bulk' || lpad(n::text, 5, '0'), 'Row ' || n FROM generate_series(1, 2345) AS n",
        ),
      );

    expect(oldRows).not.toEqual(await taskRows(h.source(), 'ontology_1_objects'));

    expect((await h.run(WRITE)).code).toBe(0);

    expect(await taskRows(h.direct(), NEW_OBJECTS)).toEqual(await taskRows(h.source(), 'ontology_1_objects'));

    expect(await h.direct().query(sql(`SELECT ROW(t.*)::text AS row FROM ${NEW_ENGINE}.edit_history t`))).toEqual(
      await h.source().query(sql('SELECT ROW(t.*)::text AS row FROM ontology_1_engine.edit_history t')),
    );

    const [restored] = await h
      .direct()
      .query(
        sql(
          `SELECT title, score::text, details IS NULL AS sql_null, details = 'null'::jsonb AS json_null FROM ${NEW_OBJECTS}.task WHERE task_id = 't1'`,
        ),
      );

    expect(restored).toEqual({ title: 'Fix the pump', score: '1.50', sql_null: false, json_null: true });

    expect(
      (await taskRows(h.direct(), NEW_OBJECTS))
        .map((value) => String(value['row']).split(',')[0] ?? '')
        .filter((key) => !key.startsWith('(bulk')),
    ).toEqual(['(t1', '(t2', '(t3']);

    expect(await taskRows(h.direct(), NEW_OBJECTS)).toHaveLength(2348);

    expect(await row(h.direct(), CURRENT)).toEqual(otherRow);

    expect(await taskRows(h.direct(), 'ontology_2_objects')).toEqual(otherRows);

    expect(await taskRows(h.direct(), 'ontology_1_objects')).toEqual(oldRows);
  });

  it('service/storage#restore: the new schemas hold each table, column, primary key, NOT NULL constraint, default, index, and policy of the source schemas', async () => {
    expect((await h.run(WRITE)).code).toBe(0);

    for (const [from, to] of [
      ['ontology_1_objects', NEW_OBJECTS],
      ['ontology_1_engine', NEW_ENGINE],
    ] as const) {
      expect(await catalog(h.direct(), to)).toEqual(await catalog(h.source(), from));
    }

    const objects = (await catalog(h.direct(), NEW_OBJECTS)) as {
      indexes: unknown[];
      policies: unknown[];
      tables: unknown[];
      constraints: unknown[];
    };

    expect(objects.tables).toEqual([{ relname: 'task', relrowsecurity: true, relforcerowsecurity: false }]);

    expect(objects.indexes).toEqual([
      {
        tablename: 'task',
        indexname: 'fk_task_due',
        indexdef: 'CREATE INDEX fk_task_due ON <schema>.task USING btree (due)',
      },
      {
        tablename: 'task',
        indexname: 'task_pkey',
        indexdef: 'CREATE UNIQUE INDEX task_pkey ON <schema>.task USING btree (task_id)',
      },
      {
        tablename: 'task',
        indexname: 'trgm_task_title',
        indexdef: 'CREATE INDEX trgm_task_title ON <schema>.task USING gin (title ontology_registry.gin_trgm_ops)',
      },
    ]);

    expect(objects.policies).toEqual([
      {
        tablename: 'task',
        policyname: 'ontology_service',
        permissive: 'PERMISSIVE',
        roles: [h.role],
        cmd: 'ALL',
        qual: 'true',
        with_check: 'true',
      },
    ]);

    expect(objects.constraints).toEqual([
      { relname: 'task', conname: 'task_pkey', contype: 'p', definition: 'PRIMARY KEY (task_id)' },
    ]);
  });

  it('service/storage#restore: the new schema holds each unique constraint of a Uniqueness constraint, with DEFERRABLE INITIALLY DEFERRED, so a swap of 2 values in 1 transaction still passes', async () => {
    await h
      .source()
      .query(
        sql(
          'ALTER TABLE ontology_1_objects.task ADD CONSTRAINT unique_task_title UNIQUE (title, done) DEFERRABLE INITIALLY DEFERRED',
        ),
      );

    expect((await h.run(WRITE)).code).toBe(0);

    const unique = sql(
      "SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE contype = 'u' AND connamespace = $1::regnamespace",
      NEW_OBJECTS,
    );

    expect(await h.direct().query(unique)).toEqual([
      { conname: 'unique_task_title', definition: 'UNIQUE (title, done) DEFERRABLE INITIALLY DEFERRED' },
    ]);

    await h.direct().transaction(async (tx) => {
      await tx.query(sql(`UPDATE ${NEW_OBJECTS}.task SET title = 'Check the valve' WHERE task_id = 't1'`));

      await tx.query(sql(`UPDATE ${NEW_OBJECTS}.task SET title = 'Fix the pump' WHERE task_id = 't3'`));
    });

    expect(
      await h
        .direct()
        .query(sql(`SELECT task_id, title FROM ${NEW_OBJECTS}.task WHERE task_id IN ('t1', 't3') ORDER BY task_id`)),
    ).toEqual([
      { task_id: 't1', title: 'Check the valve' },
      { task_id: 't3', title: 'Fix the pump' },
    ]);
  });

  it('service/storage#restore: the source snapshot ends before production adds the constraints, so a source limit of 1 second idle in a transaction does not end the copy', async () => {
    for (const db of [h.direct(), h.source()]) {
      await db.query(
        sql(
          "CREATE FUNCTION ontology_registry.slow_check(value text) RETURNS boolean LANGUAGE sql VOLATILE AS 'SELECT pg_sleep(1) IS NOT NULL'",
        ),
      );
    }

    await h
      .source()
      .query(
        sql(
          'ALTER TABLE ontology_1_objects.task ADD CONSTRAINT task_slow CHECK (ontology_registry.slow_check(task_id))',
        ),
      );

    await h.asAdmin(
      `ALTER DATABASE ${new URL(h.sourceUrl()).pathname.slice(1)} SET idle_in_transaction_session_timeout = '1s'`,
    );

    const result = await h.run(WRITE);

    expect(result).toEqual({ code: 0, stdout: [expect.any(String)], stderr: [] });

    const [constraint] = await h
      .direct()
      .query(
        sql(
          "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'task_slow' AND connamespace = $1::regnamespace",
          NEW_OBJECTS,
        ),
      );

    expect(constraint).toEqual({ definition: 'CHECK (ontology_registry.slow_check(task_id))' });

    expect(await taskRows(h.direct(), NEW_OBJECTS)).toEqual(await taskRows(h.source(), 'ontology_1_objects'));
  });

  it('service/storage#restore: each value of each column type that a table can hold reads back the same in the new schema', async () => {
    const long = 'x\\,"(){}[]'.repeat(20_000);

    await h.source().query(
      sql(`CREATE TABLE ontology_1_objects.kinds (
        id integer PRIMARY KEY, words text, long_words text, tags text[], empty_tags text[], numbers numeric, fixed numeric(30, 15), real_number double precision,
        not_a_number double precision, big bigint, small integer, flag boolean, at timestamptz, plain_at timestamp, day date, span interval, id_value uuid,
        bytes bytea, document jsonb, json_null jsonb, sql_null jsonb, nested integer[][]);
      ALTER TABLE ontology_1_objects.kinds ENABLE ROW LEVEL SECURITY;`),
    );

    await h.source().query(
      sql(
        `INSERT INTO ontology_1_objects.kinds VALUES (1, $1, $2, ARRAY[NULL, 'a', NULL, 'NULL', '', '"', '\\'], '{}', 123456789012345678901234567890.123456789012345678901234567890,
         123456789012345.123456789012345, 0.30000000000000004, 'NaN', 9223372036854775807, -2147483648, true, '2026-01-02T03:04:05.123456+05:30', 'infinity',
         '-infinity', '1 year 2 mons 3 days 04:05:06.789', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '\\x00ff5c2722', '{"a": [1, null, "\\u0001x"], "b": {"c": "\\\\"}}',
         'null', NULL, '{{1, NULL}, {3, 4}}')`,
        'text with \\0, \\x00, \\\\, a tab\t, a quote \', a "double", (parens), {braces}, and a comma,',
        long,
      ),
    );

    expect((await h.run(WRITE)).code).toBe(0);

    expect(await h.direct().query(sql(`SELECT ROW(t.*)::text AS row FROM ${NEW_OBJECTS}.kinds t`))).toEqual(
      await h.source().query(sql('SELECT ROW(t.*)::text AS row FROM ontology_1_objects.kinds t')),
    );

    const [checked] = await h.direct().query(
      sql(
        `SELECT words = $1 AS words, long_words = $2 AS long_words, tags = ARRAY[NULL, 'a', NULL, 'NULL', '', '"', '\\']::text[] AS tags, empty_tags = '{}'::text[] AS empty_tags,
                cardinality(empty_tags) AS empty_count, numbers = 123456789012345678901234567890.123456789012345678901234567890 AS numbers,
                fixed::text AS fixed, real_number = 0.30000000000000004::float8 AS real_number, not_a_number = 'NaN'::float8 AS not_a_number,
                big = 9223372036854775807 AS big, small = -2147483648 AS small, flag, at = '2026-01-01T21:34:05.123456Z'::timestamptz AS at, plain_at = 'infinity' AS plain_at,
                day = '-infinity'::date AS day, span = '1 year 2 mons 3 days 04:05:06.789'::interval AS span, bytes = '\\x00ff5c2722'::bytea AS bytes,
                document -> 'b' ->> 'c' AS backslash, json_null = 'null'::jsonb AS json_null, json_null IS NULL AS json_null_is_sql_null, sql_null IS NULL AS sql_null,
                nested = '{{1, NULL}, {3, 4}}'::integer[][] AS nested
         FROM ${NEW_OBJECTS}.kinds`,
        'text with \\0, \\x00, \\\\, a tab\t, a quote \', a "double", (parens), {braces}, and a comma,',
        long,
      ),
    );

    expect(checked).toEqual({
      words: true,
      long_words: true,
      tags: true,
      empty_tags: true,
      empty_count: 0,
      numbers: true,
      fixed: '123456789012345.123456789012345',
      real_number: true,
      not_a_number: true,
      big: true,
      small: true,
      flag: true,
      at: true,
      plain_at: true,
      day: true,
      span: true,
      bytes: true,
      backslash: '\\',
      json_null: true,
      json_null_is_sql_null: false,
      sql_null: true,
      nested: true,
    });
  });

  it.each([
    [
      'a generated column',
      'ALTER TABLE ontology_1_objects.task ADD COLUMN title_length integer GENERATED ALWAYS AS (length(title)) STORED',
      'task.title_length',
    ],
    [
      'an identity column',
      'ALTER TABLE ontology_1_objects.task ADD COLUMN serial_number integer GENERATED ALWAYS AS IDENTITY',
      'task.serial_number',
    ],
    [
      'an identity column by default',
      'ALTER TABLE ontology_1_engine.edit_history ADD COLUMN serial_number bigint GENERATED BY DEFAULT AS IDENTITY',
      'edit_history.serial_number',
    ],
  ])(
    'service/storage#restore: a source table with %s, which the copy does not make, makes restore exit 1, name it, and write nothing',
    async (_name, change, column) => {
      await h.source().query(sql(change));

      const before = [await state(h.direct()), await state(h.source())];

      for (const args of [['restore', BEHIND], WRITE]) {
        const result = await h.run(args);

        expect(result.code).toBe(1);
        expect(result.stdout).toEqual([]);

        expect(result.stderr).toEqual([
          `The source column ${column} is a generated or identity column, which the copy does not make, so restore writes nothing.`,
        ]);
      }

      expect([await state(h.direct()), await state(h.source())]).toEqual(before);
    },
  );

  it('service/storage#restore: with a role statement_timeout of 250 ms on both databases, a copy whose source read of 300000 rows and constraint check pass it switches the row, and a new session on each side still has 250 ms', async () => {
    for (const db of [h.direct(), h.source()]) {
      await db.query(
        sql(
          "CREATE FUNCTION ontology_registry.slow_check(value text) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT pg_sleep(0.5) IS NOT NULL'",
        ),
      );
    }

    await h
      .source()
      .query(
        sql(
          'ALTER TABLE ontology_1_objects.task ADD CONSTRAINT task_slow CHECK (ontology_registry.slow_check(task_id))',
        ),
      );

    await h
      .source()
      .query(
        sql(
          "CREATE TABLE ontology_1_objects.bulk (n integer NOT NULL, label text NOT NULL); INSERT INTO ontology_1_objects.bulk SELECT g, 'row ' || g FROM generate_series(1, 300000) AS g;",
        ),
      );

    for (const url of [h.directUrl(), h.sourceUrl()])
      await h.asAdmin(
        `ALTER ROLE ${h.role} IN DATABASE ${new URL(url).pathname.slice(1)} SET statement_timeout = '250ms'`,
      );

    const result = await h.run(WRITE);

    expect(result).toMatchObject({ code: 0, stderr: [] });
    expect(line(result)).toMatchObject({ to: TO_BEHIND });

    expect(await row(h.direct(), BEHIND)).toMatchObject({
      object_schema: NEW_OBJECTS,
      engine_schema: NEW_ENGINE,
      version: 3,
    });

    expect(
      await h.direct().query(sql(`SELECT count(*)::integer AS rows, sum(n)::bigint AS total FROM ${NEW_OBJECTS}.bulk`)),
    ).toEqual([{ rows: 300000, total: '45000150000' }]);

    for (const url of [h.directUrl(), h.sourceUrl()]) {
      const after = new pg.Client({ connectionString: url });

      await after.connect();

      try {
        expect((await after.query('SHOW statement_timeout')).rows).toEqual([{ statement_timeout: '250ms' }]);
      } finally {
        await after.end();
      }
    }
  });

  it('service/storage#restore: a column named t with a plain value copies, and each row of each table equals the source row, column by column', async () => {
    await h
      .source()
      .query(
        sql(
          "ALTER TABLE ontology_1_objects.task ADD COLUMN t text; UPDATE ontology_1_objects.task SET t = 'a plain text';",
        ),
      );

    const result = await h.run(WRITE);

    expect(result.stderr).toEqual([]);
    expect(result.code).toBe(0);

    expect(await columnsByRow(h.direct(), NEW_OBJECTS)).toEqual(await columnsByRow(h.source(), 'ontology_1_objects'));

    expect(await columnsByRow(h.direct(), NEW_ENGINE)).toEqual(await columnsByRow(h.source(), 'ontology_1_engine'));

    const [restored] = await h.direct().query(sql(`SELECT t, title FROM ${NEW_OBJECTS}.task WHERE task_id = 't1'`));

    expect(restored).toEqual({ t: 'a plain text', title: 'Fix the pump' });
  });

  it('service/storage#restore: a value of a column named t in the text form of a row does not replace the row', async () => {
    const forged = '(forged-t1,FORGED NAME,true,9,,,,7,)';

    await h.source().query(sql('ALTER TABLE ontology_1_objects.task ADD COLUMN t text'));

    await h
      .source()
      .query(sql("UPDATE ontology_1_objects.task SET t = '(forged-' || task_id || ',FORGED NAME,true,9,,,,7,)'"));

    expect((await h.run(WRITE)).code).toBe(0);

    expect(await columnsByRow(h.direct(), NEW_OBJECTS)).toEqual(await columnsByRow(h.source(), 'ontology_1_objects'));

    const [restored] = await h
      .direct()
      .query(sql(`SELECT task_id, title, _version::text AS version, t FROM ${NEW_OBJECTS}.task WHERE task_id = 't1'`));

    expect(restored).toEqual({ task_id: 't1', title: 'Fix the pump', version: '1', t: forged });
  });

  it('service/storage#restore: columns named after each alias and output name of the copy, after reserved words, and after their own table copy each value', async () => {
    const names = [
      't',
      'source_row',
      'row',
      'r',
      's',
      'u',
      'v',
      'x',
      'n',
      'a',
      'c',
      'd',
      'oid',
      'name',
      'user',
      'order',
      'group',
      'default',
      'null',
      'select',
      'hostile',
    ];

    const columns = names.map((name) => `${quote(name)} text`).join(', ');

    await h
      .source()
      .query(
        sql(
          `CREATE TABLE ontology_1_objects.hostile (id integer PRIMARY KEY, ${columns}); ALTER TABLE ontology_1_objects.hostile ENABLE ROW LEVEL SECURITY;`,
        ),
      );

    const values = names.map((name, index) => `(${index + 2},${name},"x,y",,"\\"")`);

    await h.source().query({
      text: `INSERT INTO ontology_1_objects.hostile (id, ${names.map(quote).join(', ')}) VALUES (1, ${names.map((_, index) => `$${index + 1}`).join(', ')}), (2, ${names.map(() => 'NULL').join(', ')})`,
      values,
    });

    const result = await h.run(WRITE);

    expect(result.stderr).toEqual([]);
    expect(result.code).toBe(0);

    expect(await columnsByRow(h.direct(), NEW_OBJECTS)).toEqual(await columnsByRow(h.source(), 'ontology_1_objects'));

    const [first] = await h
      .direct()
      .query<Record<string, unknown>>(sql(`SELECT * FROM ${NEW_OBJECTS}.hostile WHERE id = 1`));

    expect(first).toEqual(Object.fromEntries([['id', 1], ...names.map((name, index) => [name, values[index]])]));
  });

  it('service/storage#restore: the copy pins the text settings, so a source role with extra_float_digits 0 and DateStyle Postgres, MDY, and production DMY, copy each value exactly', async () => {
    await h.source().query(
      sql(`CREATE TABLE ontology_1_objects.settings (id integer PRIMARY KEY, real_number double precision, day date, span interval, mixed interval, at timestamptz, plain_at timestamp, bytes bytea, words text, negative interval);
           ALTER TABLE ontology_1_objects.settings ENABLE ROW LEVEL SECURITY;
           INSERT INTO ontology_1_objects.settings VALUES (1, 0.30000000000000004, make_date(2026, 11, 10), make_interval(1, 2, 0, 3, 4, 5, 6.789), make_interval(-1, 2, 0, -3, 4, -5, 6),
             make_timestamptz(2026, 11, 10, 1, 2, 3.456789, 'UTC'), make_timestamp(2026, 11, 10, 1, 2, 3.456789), '\\x00ff5c27'::bytea, '漢字 é', make_interval(-1, -2, 0, -3, -4, -5, -6.5));`),
    );

    const database = (url: string) => new URL(url).pathname.slice(1);

    await h.asAdmin(`ALTER ROLE ${h.role} IN DATABASE ${database(h.sourceUrl())} SET extra_float_digits = 0`);

    await h.asAdmin(`ALTER ROLE ${h.role} IN DATABASE ${database(h.sourceUrl())} SET DateStyle = 'Postgres, MDY'`);

    await h.asAdmin(`ALTER ROLE ${h.role} IN DATABASE ${database(h.sourceUrl())} SET IntervalStyle = 'sql_standard'`);

    await h.asAdmin(`ALTER ROLE ${h.role} IN DATABASE ${database(h.sourceUrl())} SET TimeZone = 'America/New_York'`);

    await h.asAdmin(`ALTER ROLE ${h.role} IN DATABASE ${database(h.sourceUrl())} SET bytea_output = 'escape'`);

    await h.asAdmin(`ALTER ROLE ${h.role} IN DATABASE ${database(h.sourceUrl())} SET client_encoding = 'LATIN1'`);

    await h.asAdmin(`ALTER ROLE ${h.role} IN DATABASE ${database(h.directUrl())} SET client_encoding = 'LATIN1'`);

    await h.asAdmin(`ALTER ROLE ${h.role} IN DATABASE ${database(h.directUrl())} SET DateStyle = 'ISO, DMY'`);

    await h.asAdmin(`ALTER ROLE ${h.role} IN DATABASE ${database(h.directUrl())} SET IntervalStyle = 'postgres'`);

    await h.asAdmin(`ALTER ROLE ${h.role} IN DATABASE ${database(h.directUrl())} SET TimeZone = 'Asia/Tokyo'`);

    const result = await h.run(WRITE);

    expect(result.stderr).toEqual([]);
    expect(result.code).toBe(0);

    const [copied] = await h.direct().query(
      sql(
        `SELECT real_number = 0.30000000000000004::float8 AS real_number, day = make_date(2026, 11, 10) AS day, span = make_interval(1, 2, 0, 3, 4, 5, 6.789) AS span, mixed = make_interval(-1, 2, 0, -3, 4, -5, 6) AS mixed,
                  at = make_timestamptz(2026, 11, 10, 1, 2, 3.456789, 'UTC') AS at, plain_at = make_timestamp(2026, 11, 10, 1, 2, 3.456789) AS plain_at,
                  bytes = '\\x00ff5c27'::bytea AS bytes, words = $1 AS words, negative = make_interval(-1, -2, 0, -3, -4, -5, -6.5) AS negative
           FROM ${NEW_OBJECTS}.settings`,
        '漢字 é',
      ),
    );

    expect(copied).toEqual({
      real_number: true,
      day: true,
      span: true,
      mixed: true,
      at: true,
      plain_at: true,
      bytes: true,
      words: true,
      negative: true,
    });
  });

  it('service/storage#restore: a source row that names other schemas than the live row copies the schemas of the source row', async () => {
    await h.source().query(
      sql(`ALTER SCHEMA ontology_1_objects RENAME TO ontology_1_objects_20250101000000;
           ALTER SCHEMA ontology_1_engine RENAME TO ontology_1_engine_20250101000000;
           UPDATE ontology_registry.ontologies SET object_schema = 'ontology_1_objects_20250101000000', engine_schema = 'ontology_1_engine_20250101000000' WHERE number = 1;`),
    );

    await h
      .source()
      .query(sql("UPDATE ontology_1_objects_20250101000000.task SET title = 'Only in the source schemas'"));

    expect((await h.run(WRITE)).code).toBe(0);

    expect(await columnsByRow(h.direct(), NEW_OBJECTS)).toEqual(
      await columnsByRow(h.source(), 'ontology_1_objects_20250101000000'),
    );

    expect(await columnsByRow(h.direct(), NEW_ENGINE)).toEqual(
      await columnsByRow(h.source(), 'ontology_1_engine_20250101000000'),
    );

    expect(await h.direct().query(sql(`SELECT DISTINCT title FROM ${NEW_OBJECTS}.task`))).toEqual([
      { title: 'Only in the source schemas' },
    ]);

    expect(await row(h.direct(), BEHIND)).toMatchObject({ object_schema: NEW_OBJECTS, engine_schema: NEW_ENGINE });
  });

  it('service/storage#restore: the copy reads each table of the source in 1 snapshot, so a write to the source between 2 table reads does not show in the copy', async () => {
    const taskBefore = await columnsByRow(h.source(), 'ontology_1_objects');

    const historyBefore = await columnsByRow(h.source(), 'ontology_1_engine');

    const holder = new pg.Client({ connectionString: h.sourceUrl() });

    await holder.connect();

    await holder.query('BEGIN');

    await holder.query('LOCK TABLE ontology_1_engine.edit_history IN ACCESS EXCLUSIVE MODE');

    let restoring;

    try {
      restoring = h.run(WRITE);

      await waitForLockWaits(h.source(), 1);

      await h.source().query(sql("UPDATE ontology_1_objects.task SET title = 'Written during the copy'"));

      await holder.query(
        "INSERT INTO ontology_1_engine.edit_history (object_type, primary_key, entry) VALUES ('Task', 't9', '{\"edit\": 9}')",
      );
    } finally {
      await holder.query('COMMIT');

      await holder.end();
    }

    expect((await restoring).code).toBe(0);

    expect(await columnsByRow(h.direct(), NEW_OBJECTS)).toEqual(taskBefore);

    expect(await columnsByRow(h.direct(), NEW_ENGINE)).toEqual(historyBefore);
  });

  it('service/storage#restore: the copy pins the parse settings of production, so array_nulls off keeps each NULL element and each text NULL of an array', async () => {
    await h.source().query(
      sql(`CREATE TABLE ontology_1_objects.arrays (id integer PRIMARY KEY, words text[], numbers integer[], flags boolean[]);
           ALTER TABLE ontology_1_objects.arrays ENABLE ROW LEVEL SECURITY;
           INSERT INTO ontology_1_objects.arrays VALUES (1, ARRAY['x', NULL, 'NULL'], ARRAY[1, NULL, 3], ARRAY[true, NULL, false]);`),
    );

    await h.asAdmin(
      `ALTER ROLE ${h.role} IN DATABASE ${new URL(h.directUrl()).pathname.slice(1)} SET array_nulls = off`,
    );

    const result = await h.run(WRITE);

    expect(result.stderr).toEqual([]);
    expect(result.code).toBe(0);

    const [copied] = await h.direct().query(
      sql(`SELECT words[1] AS first, words[2] IS NULL AS second_is_null, words[3] AS third, numbers[2] IS NULL AS number_is_null, numbers[3] AS number,
                  flags[2] IS NULL AS flag_is_null, flags[3] AS flag
           FROM ${NEW_OBJECTS}.arrays`),
    );

    expect(copied).toEqual({
      first: 'x',
      second_is_null: true,
      third: 'NULL',
      number_is_null: true,
      number: 3,
      flag_is_null: true,
      flag: false,
    });
  });

  it('service/storage#restore: the copy pins xmloption, so an XML value of content form copies when production has xmloption document', async () => {
    await h.source().query(
      sql(`CREATE TABLE ontology_1_objects.documents (id integer PRIMARY KEY, body xml);
           ALTER TABLE ontology_1_objects.documents ENABLE ROW LEVEL SECURITY;
           INSERT INTO ontology_1_objects.documents VALUES (1, XMLPARSE (CONTENT 'text and <b>a tag</b>'));`),
    );

    await h.asAdmin(
      `ALTER ROLE ${h.role} IN DATABASE ${new URL(h.directUrl()).pathname.slice(1)} SET xmloption = document`,
    );

    const result = await h.run(WRITE);

    expect(result.stderr).toEqual([]);
    expect(result.code).toBe(0);

    expect(await h.direct().query(sql(`SELECT body::text AS body FROM ${NEW_OBJECTS}.documents`))).toEqual([
      { body: 'text and <b>a tag</b>' },
    ]);
  });

  it('service/storage#restore: the copy pins standard_conforming_strings, so a default and a check with a backslash read the same in production with it off', async () => {
    await h
      .source()
      .query(
        sql(
          "ALTER TABLE ontology_1_objects.task ADD COLUMN note text DEFAULT 'a\\b'; ALTER TABLE ontology_1_objects.task ADD CONSTRAINT note_check CHECK (note <> 'x\\y');",
        ),
      );

    await h.asAdmin(
      `ALTER ROLE ${h.role} IN DATABASE ${new URL(h.directUrl()).pathname.slice(1)} SET standard_conforming_strings = off`,
    );

    const result = await h.run(WRITE);

    expect(result.stderr).toEqual([]);
    expect(result.code).toBe(0);

    const [inserted] = await h
      .direct()
      .query(sql(`INSERT INTO ${NEW_OBJECTS}.task (task_id) VALUES ('t9') RETURNING note`));

    expect(inserted).toEqual({ note: 'a\\b' });

    await expect(
      h.direct().query(sql(`INSERT INTO ${NEW_OBJECTS}.task (task_id, note) VALUES ('t10', $1)`, 'x\\y')),
    ).rejects.toMatchObject({ code: '23514' });

    await h.direct().query(sql(`INSERT INTO ${NEW_OBJECTS}.task (task_id, note) VALUES ('t11', $1)`, 'x\by'));
  });

  it('service/storage#restore: a production database in LATIN1 and a source in UTF8: a value that both encodings hold copies exactly', async () => {
    const latin = await h.newProduction('latin', 'LATIN1');

    const value = 'é and ß';

    await h.source().query(sql("UPDATE ontology_1_objects.task SET title = $1 WHERE task_id = 't1'", value));

    const result = await h.run(WRITE, {}, { DATABASE_URL_DIRECT: latin.url, RESTORE_SOURCE_URL: h.sourceUrl() });

    expect(result.stderr).toEqual([]);
    expect(result.code).toBe(0);

    expect(await latin.db.query(sql(`SELECT title FROM ${NEW_OBJECTS}.task WHERE task_id = 't1'`))).toEqual([
      { title: value },
    ]);
  });

  it('service/storage#restore: a production database in LATIN1 and a source in UTF8: a value that the production encoding cannot hold fails closed', async () => {
    const latin = await h.newProduction('latin', 'LATIN1');

    await h.source().query(sql("UPDATE ontology_1_objects.task SET title = $1 WHERE task_id = 't1'", '漢字'));

    const before = await state(latin.db);

    const result = await h.run(WRITE, {}, { DATABASE_URL_DIRECT: latin.url, RESTORE_SOURCE_URL: h.sourceUrl() });

    expect(result).toEqual({
      code: 1,
      stdout: [],
      stderr: [
        `The command failed with the error code 22P05. The copy may have left the schemas ${NEW_OBJECTS} and ${NEW_ENGINE}.`,
      ],
    });

    expect(await state(latin.db)).toEqual(before);
  });

  it('service/storage#restore: the copy pins standard_conforming_strings in the source, so a source role with it off copies each default, check, and partial index with a backslash exactly', async () => {
    await h.source().query(
      sql(`ALTER TABLE ontology_1_objects.task ADD COLUMN note text DEFAULT 'a\\b', ADD COLUMN notes text[] DEFAULT ARRAY['c\\d'], ADD COLUMN extra jsonb DEFAULT '{"k": "e\\\\f"}';
           ALTER TABLE ontology_1_objects.task ADD CONSTRAINT note_check CHECK (note <> 'x\\y');
           CREATE INDEX note_like ON ontology_1_objects.task (note) WHERE note LIKE 'a\\\\%';`),
    );

    await h.asAdmin(
      `ALTER ROLE ${h.role} IN DATABASE ${new URL(h.sourceUrl()).pathname.slice(1)} SET standard_conforming_strings = off`,
    );

    const result = await h.run(WRITE);

    expect(result.stderr).toEqual([]);
    expect(result.code).toBe(0);

    const definitions = async (db: Db, schema: string) => ({
      defaults: await db.query(
        sql(
          `SELECT column_name, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'task' AND column_name IN ('note', 'notes', 'extra') ORDER BY 1`,
          schema,
        ),
      ),
      checks: await db.query(
        sql(
          `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace = $1::regnamespace AND conname = 'note_check'`,
          schema,
        ),
      ),
      indexes: await db.query(
        sql(
          `SELECT replace(indexdef, $1 || '.', '') AS definition FROM pg_indexes WHERE schemaname = $1 AND indexname = 'note_like'`,
          schema,
        ),
      ),
    });

    expect(await definitions(h.direct(), NEW_OBJECTS)).toEqual(await definitions(h.source(), 'ontology_1_objects'));

    const [inserted] = await h
      .direct()
      .query(sql(`INSERT INTO ${NEW_OBJECTS}.task (task_id) VALUES ('t9') RETURNING note, notes, extra ->> 'k' AS k`));

    expect(inserted).toEqual({ note: 'a\\b', notes: ['c\\d'], k: 'e\\f' });

    await expect(
      h.direct().query(sql(`INSERT INTO ${NEW_OBJECTS}.task (task_id, note) VALUES ('t10', $1)`, 'x\\y')),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('service/storage#restore: the copy pins IntervalStyle in the source, so -3 days -04:05:06 from a source with sql_standard reads the same in production with each other style', async () => {
    await h.source().query(
      sql(`CREATE TABLE ontology_1_objects.spans (id integer PRIMARY KEY, span interval, spans interval[]);
           ALTER TABLE ontology_1_objects.spans ENABLE ROW LEVEL SECURITY;
           INSERT INTO ontology_1_objects.spans VALUES (1, '-3 days -04:05:06', ARRAY['-3 days -04:05:06'::interval, '1 day 02:00:00'::interval]);`),
    );

    await h.asAdmin(
      `ALTER ROLE ${h.role} IN DATABASE ${new URL(h.sourceUrl()).pathname.slice(1)} SET IntervalStyle = 'sql_standard'`,
    );

    for (const style of ['postgres', 'postgres_verbose', 'iso_8601']) {
      const production = await h.newProduction(`spans_${style}`);

      await h.asAdmin(
        `ALTER ROLE ${h.role} IN DATABASE ${new URL(production.url).pathname.slice(1)} SET IntervalStyle = '${style}'`,
      );

      const result = await h.run(WRITE, {}, { DATABASE_URL_DIRECT: production.url, RESTORE_SOURCE_URL: h.sourceUrl() });

      expect(result.stderr).toEqual([]);
      expect(result.code).toBe(0);

      const [copied] = await production.db.query(
        sql(
          `SELECT span = '-3 days -04:05:06'::interval AS span, spans = ARRAY['-3 days -04:05:06'::interval, '1 day 02:00:00'::interval] AS spans FROM ${NEW_OBJECTS}.spans`,
        ),
      );

      expect({ style, ...copied }).toEqual({ style, span: true, spans: true });
    }
  });
});
