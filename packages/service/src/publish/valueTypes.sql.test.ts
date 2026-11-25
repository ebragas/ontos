import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../db/index.ts';
import type { CompiledProperty, CompiledValueType, ValueTypeRule } from '../ontology/index.ts';
import type { PublishResponse, SchemaMigration } from './index.ts';
import { installOntology } from '../install.test-utils.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { realCompile } from './realCompile.test-utils.ts';
import {
  expectAllOnNewest,
  modeOf,
  NAMESPACE,
  newDatabase,
  objectType,
  ontology,
  property,
  publishAndInstall,
  PUBLISHER,
  refusal,
  request,
  sql,
  type Db,
  type TestDatabase,
} from './publish.test-utils.ts';
import { TEST_ONTOLOGY_RID, TEST_PRODUCT } from '../service.test-utils.ts';
import { ORGANIZATION } from '../tokens.test-utils.ts';

const TASK = `${NAMESPACE}Task`;
const OF = `of Object Type ${TASK}`;

let postgres: TestPostgres;
let database: TestDatabase;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  database = await newDatabase(postgres.url);
});

afterEach(async () => {
  await expectAllOnNewest(database.db);

  await database.end();
});

function valueType(
  apiName: string,
  rules: readonly ValueTypeRule[],
  more: Partial<CompiledValueType> = {},
): CompiledValueType {
  return {
    apiName,
    rid: `ri.type-registry.main.value-type.${apiName}`,
    version: '1.0.0',
    status: 'active',
    displayName: apiName,
    description: undefined,
    baseType: { kind: 'string' },
    constraints: rules.map((rule) => ({ rule, failureMessage: undefined })),
    ...more,
  };
}

const TASK_STATUS = valueType('taskStatus', [{ kind: 'enum', options: ['open', 'done'] }]);

const taskId = property('taskId', 'task_id', { kind: 'string' }, true);
const status = property('status', 'status', { kind: 'string' });
const state = property('state', 'state', { kind: 'string' });
const code = property('code', 'code', { kind: 'string' });
const labels = property('labels', 'labels', { kind: 'array', element: { kind: 'string' } });

const tags = (maximumSize: number) =>
  valueType('tags', [{ kind: 'array', minimumSize: 1, maximumSize, uniqueValues: false }], {
    baseType: { kind: 'array', element: 'string' },
  });

function typed(
  base: CompiledProperty,
  type: CompiledValueType | undefined,
  required = base.required,
): CompiledProperty {
  return { ...base, required, ...(type ? { valueType: type } : {}) };
}

function tasks(properties: readonly CompiledProperty[], primaryKey = 'taskId') {
  return ontology({ objectTypes: [objectType(TASK, 'task', primaryKey, [taskId, ...properties])] });
}

interface PublishOptions {
  readonly validateOnly?: boolean;
  readonly migrations?: readonly SchemaMigration[];
  readonly db?: Db;
}

function publish(literal: ReturnType<typeof tasks>, options: PublishOptions = {}): Promise<PublishResponse> {
  const { ontology: compiled, ir } = realCompile(literal);
  const validateOnly = options.validateOnly ?? false;

  return publishAndInstall(options.db ?? database.db, {
    ...TEST_PRODUCT,
    ontology: compiled,
    request: {
      ...request(validateOnly),
      ir,
      product: 'twin',
      schemaMigrations: { migrations: options.migrations ?? [] },
    },
    publisher: PUBLISHER,
    mode: modeOf(validateOnly),
  });
}

async function refusals(
  literal: ReturnType<typeof tasks>,
  options: Omit<PublishOptions, 'validateOnly'> = {},
): Promise<unknown[]> {
  const answers: unknown[] = [];

  for (const validateOnly of [true, false]) {
    const error = await refusal(publish(literal, { ...options, validateOnly }));

    const parameters = Object.fromEntries(Object.entries(error.parameters).filter(([key]) => key !== 'transactionMs'));

    answers.push([error.status, error.errorName, parameters]);
  }

  return answers;
}

function refused(parameters: Record<string, unknown>, ontologyRid = TEST_ONTOLOGY_RID): unknown[] {
  const answer = [400, 'Default:InvalidArgument', { ...parameters, ontologyRid }];

  return [answer, answer];
}

async function versions(): Promise<number[]> {
  const rows = await database.db.query<{ version: number }>(
    sql('SELECT version FROM ontology_registry.product_versions ORDER BY version'),
  );

  return rows.map((row) => row.version);
}

async function insertTasks(rows: readonly Record<string, unknown>[], schema = 'ontology_1_objects'): Promise<void> {
  for (const row of rows) {
    const columns = Object.keys(row);
    const places = columns.map((_, i) => `$${i + 1}`);

    await database.db.query(
      sql(`INSERT INTO ${schema}.task (${columns.join(', ')}) VALUES (${places.join(', ')})`, ...Object.values(row)),
    );
  }
}

async function storedTasks(schema = 'ontology_1_objects'): Promise<Record<string, unknown>[]> {
  return database.db.query(sql(`SELECT * FROM ${schema}.task ORDER BY task_id`));
}

const keys = (count: number) => Array.from({ length: count }, (_, index) => `t-${String(index + 1).padStart(2, '0')}`);

describe('ontology/object-link-types/value-types#check-at-publish', () => {
  it('ontology/object-link-types/value-types#check-at-publish: a publish that gives a Property a value type fails on 11 bad Objects with the first 10 keys in order, and writes nothing', async () => {
    await publish(tasks([status]));

    const bad = keys(11);

    await insertTasks([...bad].reverse().map((id) => ({ task_id: id, status: 'lost' })));

    await insertTasks([
      { task_id: 'u-1', status: 'open' },
      { task_id: 'u-2', status: null },
    ]);

    const before = await storedTasks();

    expect(await refusals(tasks([typed(status, TASK_STATUS)]))).toEqual(
      refused({
        change: `Set the value type taskStatus on Property status ${OF}`,
        objectType: TASK,
        property: 'status',
        valueType: 'taskStatus',
        badObjects: 11,
        primaryKeys: bad.slice(0, 10),
      }),
    );

    expect(await versions()).toEqual([1]);

    expect(await storedTasks()).toEqual(before);
  });

  it('ontology/object-link-types/value-types#check-at-publish: with good data and no value, the publish that gives a Property a value type passes', async () => {
    await publish(tasks([status]));

    await insertTasks([
      { task_id: 't-1', status: 'open' },
      { task_id: 't-2', status: 'done' },
      { task_id: 't-3', status: null },
    ]);

    const response = await publish(tasks([typed(status, TASK_STATUS)]));

    expect(response.version).toBe(2);

    expect(response.changes.map((change) => change.description)).toEqual([
      `Set the value type taskStatus on Property status ${OF}`,
    ]);
  });

  it('ontology/object-link-types/value-types#check-at-publish: a change of the constraints runs the check, and the publish passes after the bad value is fixed', async () => {
    const wide = valueType('taskStatus', [{ kind: 'enum', options: ['open', 'done', 'lost'] }]);

    await publish(tasks([typed(status, wide)]));

    await insertTasks([
      { task_id: 't-1', status: 'open' },
      { task_id: 't-2', status: 'lost' },
    ]);

    const tight = tasks([typed(status, TASK_STATUS)]);

    expect(await refusals(tight)).toEqual(
      refused({
        change: `Change the value type taskStatus of Property status ${OF}`,
        objectType: TASK,
        property: 'status',
        valueType: 'taskStatus',
        badObjects: 1,
        primaryKeys: ['t-2'],
      }),
    );

    await database.db.query(sql("UPDATE ontology_1_objects.task SET status = 'done' WHERE task_id = 't-2'"));

    expect((await publish(tight)).version).toBe(2);
  });

  it('ontology/object-link-types/value-types#check-at-publish: a change of the API name alone runs the check, and names the new value type', async () => {
    await publish(tasks([typed(status, TASK_STATUS)]));

    await insertTasks([{ task_id: 't-1', status: 'lost' }]);

    const renamed = valueType('workStatus', [{ kind: 'enum', options: ['open', 'done'] }]);

    expect(await refusals(tasks([typed(status, renamed)]))).toEqual(
      refused({
        change: `Change the value type workStatus of Property status ${OF}`,
        objectType: TASK,
        property: 'status',
        valueType: 'workStatus',
        badObjects: 1,
        primaryKeys: ['t-1'],
      }),
    );

    expect(await versions()).toEqual([1]);
  });

  it('ontology/object-link-types/value-types#check-at-publish: a new version label, failure message, display name, description, or status alone runs no check', async () => {
    await publish(tasks([typed(status, TASK_STATUS)]));

    await insertTasks([{ task_id: 't-1', status: 'lost' }]);

    const labels: CompiledValueType[] = [
      { ...TASK_STATUS, version: '1.1.0' },
      {
        ...TASK_STATUS,
        version: '1.1.0',
        constraints: [{ rule: { kind: 'enum', options: ['open', 'done'] }, failureMessage: 'Use open or done.' }],
      },
      { ...TASK_STATUS, version: '1.1.0', displayName: 'Task status' },
      { ...TASK_STATUS, version: '1.1.0', description: 'The status of a task.' },
      { ...TASK_STATUS, version: '1.1.0', status: 'deprecated' },
    ];

    let version = 1;

    for (const label of labels) {
      const response = await publish(tasks([typed(status, label)]));

      expect(response.changes).toEqual([]);

      version += 1;

      expect(response.version).toBe(version);
    }
  });

  it('ontology/object-link-types/value-types#check-at-publish: removing a value type runs no check', async () => {
    await publish(tasks([typed(status, TASK_STATUS)]));

    await insertTasks([{ task_id: 't-1', status: 'lost' }]);

    const response = await publish(tasks([status]));

    expect(response.version).toBe(2);

    expect(response.changes.map((change) => change.description)).toEqual([
      `Remove the value type taskStatus from Property status ${OF}`,
    ]);
  });

  it('ontology/object-link-types/value-types#check-at-publish: a change of the base type with a Drop leaves no stored value, so the publish passes', async () => {
    await publish(tasks([typed(status, TASK_STATUS)]));

    await insertTasks([{ task_id: 't-1', status: 'open' }]);

    const level = valueType('taskStatus', [{ kind: 'enum', options: [1, 2] }], { baseType: { kind: 'integer' } });
    const asNumber = typed(property('status', 'status', { kind: 'integer' }), level);

    const response = await publish(tasks([asNumber]), {
      migrations: [{ type: 'dropProperty', objectType: TASK, property: 'status' }],
    });

    expect(response.version).toBe(2);

    expect(await storedTasks()).toEqual([{ task_id: 't-1', status: null, __version: expect.any(String) }]);
  });

  it('ontology/object-link-types/value-types#check-at-publish: a Decimal range compares each stored value exactly, also past 2^53', async () => {
    const amount = property('amount', 'amount', { kind: 'decimal', precision: 20, scale: 0 });

    await publish(tasks([amount]));

    await insertTasks([
      { task_id: 't-1', amount: '9007199254740992' },
      { task_id: 't-2', amount: '9007199254740993' },
    ]);

    const cap = valueType('cap', [{ kind: 'range', maximum: '9007199254740992' }], { baseType: { kind: 'decimal' } });

    expect(await refusals(tasks([typed(amount, cap)]))).toEqual(
      refused({
        change: `Set the value type cap on Property amount ${OF}`,
        objectType: TASK,
        property: 'amount',
        valueType: 'cap',
        badObjects: 1,
        primaryKeys: ['t-2'],
      }),
    );
  });

  it('ontology/object-link-types/value-types#check-at-publish: a Move into a Property with another value type checks the values of the old Property', async () => {
    await publish(tasks([state]));

    await insertTasks([
      { task_id: 't-1', state: 'open' },
      { task_id: 't-2', state: 'lost' },
    ]);

    const move: SchemaMigration = { type: 'renameProperty', objectType: TASK, source: 'state', target: 'status' };
    const moved = tasks([typed(status, TASK_STATUS)]);

    expect(await refusals(moved, { migrations: [move] })).toEqual(
      refused({
        change: `Move Property state to status ${OF}`,
        objectType: TASK,
        property: 'state',
        valueType: 'taskStatus',
        badObjects: 1,
        primaryKeys: ['t-2'],
      }),
    );

    await database.db.query(sql("UPDATE ontology_1_objects.task SET state = 'done' WHERE task_id = 't-2'"));

    expect((await publish(moved, { migrations: [move] })).version).toBe(2);

    expect(await storedTasks()).toEqual([
      { task_id: 't-1', status: 'open', __version: expect.any(String) },
      { task_id: 't-2', status: 'done', __version: expect.any(String) },
    ]);
  });

  it('ontology/object-link-types/value-types#check-at-publish: a Move into a required Property with a value type runs the required check first', async () => {
    await publish(tasks([state]));

    await insertTasks([
      { task_id: 't-1', state: null },
      { task_id: 't-2', state: 'lost' },
    ]);

    const migrations: SchemaMigration[] = [
      { type: 'renameProperty', objectType: TASK, source: 'state', target: 'status' },
    ];

    const moved = tasks([typed(status, TASK_STATUS, true)]);
    const change = `Move Property state to status ${OF}`;

    expect(await refusals(moved, { migrations })).toEqual(
      refused({ change, objectType: TASK, property: 'state', badObjects: 1, primaryKeys: ['t-1'] }),
    );

    await database.db.query(sql("UPDATE ontology_1_objects.task SET state = 'open' WHERE task_id = 't-1'"));

    expect(await refusals(moved, { migrations })).toEqual(
      refused({
        change,
        objectType: TASK,
        property: 'state',
        valueType: 'taskStatus',
        badObjects: 1,
        primaryKeys: ['t-2'],
      }),
    );
  });

  it('ontology/object-link-types/value-types#check-at-publish: a Property made required and given a value type runs the required check first', async () => {
    await publish(tasks([status]));

    await insertTasks([
      { task_id: 't-1', status: null },
      { task_id: 't-2', status: 'lost' },
    ]);

    const next = tasks([typed(status, TASK_STATUS, true)]);

    expect(await refusals(next)).toEqual(
      refused({
        change: `Make Property status required ${OF}`,
        objectType: TASK,
        property: 'status',
        badObjects: 1,
        primaryKeys: ['t-1'],
      }),
    );
  });

  it('ontology/object-link-types/value-types#check-at-publish: a Drop of the old Property with a new Property that has a value type runs no check', async () => {
    await publish(tasks([state]));

    await insertTasks([{ task_id: 't-1', state: 'lost' }]);

    const response = await publish(tasks([typed(status, TASK_STATUS)]), {
      migrations: [{ type: 'dropProperty', objectType: TASK, property: 'state' }],
    });

    expect(response.version).toBe(2);
  });

  it('ontology/object-link-types/value-types#check-at-publish: a Drop of all Objects runs no check', async () => {
    await publish(tasks([status, code]));

    await insertTasks([{ task_id: 't-1', status: 'lost', code: 'c-1' }]);

    const response = await publish(tasks([typed(status, TASK_STATUS), { ...code, required: true }], 'code'), {
      migrations: [{ type: 'dropAllPatches', objectType: TASK }],
    });

    expect(response.version).toBe(2);

    expect(await storedTasks()).toEqual([]);
  });

  it('ontology/object-link-types/value-types#check-at-publish: a stored [] gets no check, so a publish that raises the maximum size passes under a minimum size of 1', async () => {
    await publish(tasks([typed(labels, tags(5))]));

    await insertTasks([
      { task_id: 't-1', labels: [] },
      { task_id: 't-2', labels: ['a'] },
    ]);

    expect((await publish(tasks([typed(labels, tags(6))]))).version).toBe(2);
  });

  it('ontology/object-link-types/value-types#check-at-publish: a stored list that is not [] gets the check, also next to a stored []', async () => {
    await publish(tasks([typed(labels, tags(5))]));

    await insertTasks([
      { task_id: 't-1', labels: [] },
      { task_id: 't-2', labels: ['a', 'b', 'c', 'd', 'e'] },
    ]);

    expect(await refusals(tasks([typed(labels, tags(4))]))).toEqual(
      refused({
        change: `Change the value type tags of Property labels ${OF}`,
        objectType: TASK,
        property: 'labels',
        valueType: 'tags',
        badObjects: 1,
        primaryKeys: ['t-2'],
      }),
    );
  });

  it('ontology/object-link-types/value-types#check-at-publish: a fault of the database in the value check gives 500 and stores nothing', async () => {
    await publish(tasks([status]));

    await insertTasks([{ task_id: 't-1', status: 'open' }]);

    const faulting: Db = {
      ...database.db,
      stream: (statement: Sql) =>
        statement.text.includes('"status" IS NOT NULL') ? failingStream() : database.db.stream(statement),
    };

    for (const validateOnly of [true, false]) {
      const error = await refusal(publish(tasks([typed(status, TASK_STATUS)]), { validateOnly, db: faulting }));

      expect([error.status, error.errorName]).toEqual([500, 'Default:Internal']);
    }

    expect(await versions()).toEqual([1]);
  });

  it('ontology/object-link-types/value-types#check-at-publish: the check streams the column, so no read of the publish holds the 20000 rows that it counts', async () => {
    await publish(tasks([status]));

    await database.db.query(
      sql(
        "INSERT INTO ontology_1_objects.task (task_id, status) SELECT 't-' || lpad(g::text, 5, '0'), 'lost' FROM generate_series(1, 20000) AS g",
      ),
    );

    let largestQuery = 0;
    let streamed = 0;

    const counting: Db = {
      ...database.db,
      query: async <Row extends object>(statement: Sql) => {
        const rows = await database.db.query<Row>(statement);

        largestQuery = Math.max(largestQuery, rows.length);

        return rows;
      },
      stream: async function* <Row extends object>(statement: Sql) {
        for await (const row of database.db.stream<Row>(statement)) {
          streamed += 1;

          yield row;
        }
      },
    };

    const error = await refusal(publish(tasks([typed(status, TASK_STATUS)]), { validateOnly: true, db: counting }));

    expect([error.parameters['badObjects'], error.parameters['primaryKeys']]).toEqual([
      20000,
      ['t-00001', 't-00002', 't-00003', 't-00004', 't-00005', 't-00006', 't-00007', 't-00008', 't-00009', 't-00010'],
    ]);

    expect(streamed).toBe(20000);
    expect(largestQuery).toBeLessThan(100);
  });
});

async function* failingStream(): AsyncGenerator<never, undefined, undefined> {
  await Promise.reject(Object.assign(new Error('fault'), { code: '08006' }));

  yield* [];
}

describe('service/publish#applying', () => {
  it('service/publish#applying: a publish with 2 installations fails when only the second one has a bad value, and names the second one', async () => {
    await publish(tasks([status]));

    await insertTasks([{ task_id: 't-1', status: 'open' }]);

    const second = `ri.ontology.main.ontology.${crypto.randomUUID()}`;

    await installOntology(database.db, {
      rid: second,
      product: TEST_PRODUCT.product,
      apiName: 'second',
      displayName: 'second',
      organization: ORGANIZATION,
    });

    await insertTasks([{ task_id: 't-9', status: 'lost' }], 'ontology_2_objects');

    expect(await refusals(tasks([typed(status, TASK_STATUS)]))).toEqual(
      refused(
        {
          change: `Set the value type taskStatus on Property status ${OF}`,
          objectType: TASK,
          property: 'status',
          valueType: 'taskStatus',
          badObjects: 1,
          primaryKeys: ['t-9'],
        },
        second,
      ),
    );

    expect(await versions()).toEqual([1]);
  });

  it('service/publish#applying: the transaction checks again under the SHARE lock, so a bad value written after the check fails the publish', async () => {
    await publish(tasks([status]));

    await insertTasks([{ task_id: 't-1', status: 'open' }]);

    let written = false;

    const writing: Db = {
      ...database.db,
      transaction: async (run) => {
        if (!written) await insertTasks([{ task_id: 't-2', status: 'lost' }]);

        written = true;

        return database.db.transaction(run);
      },
    };

    const error = await refusal(publish(tasks([typed(status, TASK_STATUS)]), { db: writing }));

    const { transactionMs, ...parameters } = error.parameters;

    expect([error.status, error.errorName, parameters, typeof transactionMs]).toEqual([
      400,
      'Default:InvalidArgument',
      {
        change: `Set the value type taskStatus on Property status ${OF}`,
        objectType: TASK,
        property: 'status',
        valueType: 'taskStatus',
        badObjects: 1,
        primaryKeys: ['t-2'],
        ontologyRid: TEST_ONTOLOGY_RID,
      },
      'number',
    ]);

    expect(await versions()).toEqual([1]);
  });
});
