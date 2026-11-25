import type { OntologyIr } from '@osdk/client.unstable';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from '../db/index.ts';
import { createDb, createPool, type Db } from '../db/promise.test-utils.ts';
import { actionOf, ScriptedFunctions, withFunctions } from '../functions/functions.test-utils.ts';
import { propertyOfType, renamed, STRING_FLAGS, twinObjectType, unchecked } from '../ontology/stored.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import { routeSpans, routeTraceProblems } from '../routeHarness.test-utils.ts';
import type { Edit } from './edit.ts';
import {
  account,
  actionType,
  engagement,
  errorAnswer,
  insertObjects,
  manyToManyLink,
  modifyRule,
  NS,
  parameterValue,
  rowsOf,
  startActions,
  twinIr,
  type ActionsService,
} from './actions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const BATCH_PROBE = `${NS}BatchProbe`;
const SCRIPTED_ACTION = actionOf('scripted');
const MODIFY_TWO = `${NS}batch-modify-two`;
const EXECUTE_NONE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };

type PropertyBlock = ReturnType<typeof propertyOfType>;

const scalar = (type: object) => unchecked<PropertyBlock['type']>(type);

const arrayOf = (subtype: object) =>
  unchecked<PropertyBlock['type']>({ type: 'array', array: { subtype, reducers: [] } });

const decimal = (precision: number, scale: number) => ({ type: 'decimal', decimal: { precision, scale } });

const structField = (apiName: string, fieldType: object) => ({
  apiName,
  displayMetadata: { displayName: apiName },
  typeClasses: [],
  aliases: [],
  fieldType,
});

function batchProbe(): OntologyIr['ontology']['objectTypes'][string] {
  const block = renamed(twinObjectType('Account'), BATCH_PROBE);

  const properties = [
    propertyOfType('flag', scalar({ type: 'boolean', boolean: {} })),
    propertyOfType('count', scalar({ type: 'integer', integer: {} })),
    propertyOfType('ratio', scalar({ type: 'double', double: {} })),
    propertyOfType('amount', scalar(decimal(10, 2))),
    propertyOfType('day', scalar({ type: 'date', date: {} })),
    propertyOfType('occurredAt', scalar({ type: 'timestamp', timestamp: {} })),
    propertyOfType(
      'details',
      scalar({
        type: 'struct',
        struct: {
          structFields: [structField('label', { type: 'string', string: {} }), structField('price', decimal(10, 2))],
        },
      }),
    ),
    propertyOfType('tags', arrayOf({ type: 'string', string: STRING_FLAGS })),
    propertyOfType('flags', arrayOf({ type: 'boolean', boolean: {} })),
    propertyOfType('counts', arrayOf({ type: 'integer', integer: {} })),
    propertyOfType('ratios', arrayOf({ type: 'double', double: {} })),
    propertyOfType('amounts', arrayOf(decimal(10, 2))),
    propertyOfType('days', arrayOf({ type: 'date', date: {} })),
    propertyOfType('timestamps', arrayOf({ type: 'timestamp', timestamp: {} })),
  ];

  for (const property of properties) block.objectType.propertyTypes[property.apiName] = property;

  block.entityMetadata = unchecked({
    ...block.entityMetadata,
    editsHistory: { type: 'config', config: { store: BATCH_PROBE, storeAllPreviousProperties: false } },
  });

  return block;
}

function testIr(): OntologyIr {
  const ir = twinIr('0.6.3');

  for (const apiName of [ACCOUNT, ENGAGEMENT]) {
    const block = ir.ontology.objectTypes[apiName];

    if (!block) throw new Error(`The twin 0.6.3 IR has no ${apiName}.`);

    block.entityMetadata = unchecked({
      ...block.entityMetadata,
      editsHistory: { type: 'config', config: { store: apiName, storeAllPreviousProperties: false } },
    });
  }

  ir.ontology.objectTypes[BATCH_PROBE] = batchProbe();

  const sponsors = manyToManyLink(
    'engagement-sponsors',
    { type: ENGAGEMENT, key: 'engagementId', side: 'sponsors' },
    { type: ACCOUNT, key: 'accountId', side: 'sponsoredEngagements' },
  );

  ir.ontology.linkTypes[sponsors.linkType.id] = sponsors;

  const selfLink = manyToManyLink(
    'account-peers',
    { type: ACCOUNT, key: 'accountId', side: 'peers' },
    { type: ACCOUNT, key: 'accountId', side: 'peerOf' },
  );

  ir.ontology.linkTypes[selfLink.linkType.id] = selfLink;

  const objectQuery = { type: 'objectQuery', objectQuery: { type: 'objectQuery', objectQuery: {} } };
  const required = { type: 'required', required: {} };
  const text = { type: 'text', text: { type: 'text', text: {} } };

  ir.ontology.actionTypes[MODIFY_TWO] = unchecked(
    actionType(
      MODIFY_TWO,
      {
        first: {
          type: { type: 'objectReference', objectReference: { objectTypeId: ACCOUNT } },
          allowedValues: objectQuery,
          required,
        },
        second: {
          type: { type: 'objectReference', objectReference: { objectTypeId: ACCOUNT } },
          allowedValues: objectQuery,
          required,
        },
        name: { type: { type: 'string', string: {} }, allowedValues: text, required },
      },
      [modifyRule('first', { name: parameterValue('name') }), modifyRule('second', { name: parameterValue('name') })],
    ),
  );

  return ir;
}

const locator = (objectType: string, primaryKey: string) => ({ objectType, primaryKey });

const addEdit = (objectType: string, primaryKey: string, properties: Record<string, unknown> = {}): Edit => ({
  type: 'addObject',
  object: locator(objectType, primaryKey),
  properties: new Map(Object.entries(properties)) as Extract<Edit, { type: 'addObject' }>['properties'],
});

const modifyEdit = (objectType: string, primaryKey: string, properties: Record<string, unknown>): Edit => ({
  type: 'modifyObject',
  object: locator(objectType, primaryKey),
  properties: new Map(Object.entries(properties)) as Extract<Edit, { type: 'modifyObject' }>['properties'],
});

const deleteEdit = (objectType: string, primaryKey: string): Edit => ({
  type: 'deleteObject',
  object: locator(objectType, primaryKey),
});

const linkEdit = (
  type: 'addLink' | 'deleteLink',
  link: string,
  source: { objectType: string; primaryKey: string },
  target: { objectType: string; primaryKey: string },
): Edit => ({
  type,
  link,
  source,
  target,
});

let service: ActionsService;
let scripted: ScriptedFunctions;

beforeAll(async () => {
  const ir = testIr();

  scripted = new ScriptedFunctions(ir);

  const fn = {
    apiName: 'scripted',
    inputs: [{ name: 'account', type: 'object', objectType: ACCOUNT }],
    edits: [ACCOUNT, ENGAGEMENT, BATCH_PROBE],
    links: ['engagementSponsors', 'accountPeers'],
  } as const;

  const { ir: withScripted, functions } = await withFunctions([fn], scripted.source, ir);

  service = await startActions(withScripted, functions);
});

afterAll(async () => {
  scripted?.close();

  await service?.stop();
});

beforeEach(async () => {
  scripted.reset();

  await service.clear();

  await insertObjects(service.db, ACCOUNT, [account('anchor', 'Anchor', 'customer')]);
});

afterEach(() => {
  vi.useRealTimers();
});

const applyScripted = (edits: readonly Edit[], db?: Db) => {
  scripted.once(() => edits);

  return service.apply(
    SCRIPTED_ACTION,
    { parameters: { account: 'anchor' }, options: EXECUTE_NONE },
    db ? { db } : undefined,
  );
};

const historyCount = async () => {
  const [row] = await service.db.query<{ count: number }>(
    sql('SELECT count(*)::int AS count FROM ontology_1_engine.edit_history'),
  );

  return row?.count ?? 0;
};

describe('batched Action locks and writes', () => {
  it('service/observability#traces: a 160-edit bulk apply emits bounded batched SQL spans per Object Type rather than 1 SQL span per Object row', async () => {
    const existing = Array.from({ length: 80 }, (_, index) =>
      account(`acc-${String(index).padStart(3, '0')}`, `Name ${index}`, 'prospect'),
    );

    await insertObjects(service.db, ACCOUNT, existing);

    await routeSpans();

    const edits: Edit[] = [
      ...Array.from({ length: 40 }, (_, index) =>
        addEdit(ACCOUNT, `new-${String(index).padStart(3, '0')}`, { name: `New ${index}`, phase: 'customer' }),
      ),
      ...Array.from({ length: 40 }, (_, index) =>
        modifyEdit(ACCOUNT, `acc-${String(index).padStart(3, '0')}`, { name: `Updated ${index}` }),
      ),
      ...Array.from({ length: 40 }, (_, index) => deleteEdit(ACCOUNT, `acc-${String(index + 40).padStart(3, '0')}`)),
      ...Array.from({ length: 40 }, (_, index) =>
        addEdit(ENGAGEMENT, `eng-${String(index).padStart(3, '0')}`, { title: `Eng ${index}`, status: 'open' }),
      ),
    ];

    const answer = await applyScripted(edits);

    expect(answer.status).toBe(200);

    const spans = await routeSpans();

    expect(routeTraceProblems(spans)).toEqual([]);

    const writeSqlSpans = spans.filter((span) => span.name === 'sql' && span.attributes['sql.held'] === true);

    expect(writeSqlSpans.length).toBeLessThanOrEqual(20);
  });

  it('service/storage#writes: multi-hundred-row creates, modifies, deletes, and Links commit atomically with distinct versions and full history', async () => {
    const count = 250;

    const seedAccounts = Array.from({ length: count * 2 }, (_, index) =>
      account(`seed-${String(index).padStart(3, '0')}`, `Seed ${index}`, 'prospect'),
    );

    const seedEngagements = Array.from({ length: 20 }, (_, index) =>
      engagement(`eng-${String(index).padStart(2, '0')}`, 'anchor', `Eng ${index}`, 100, 'open', null),
    );

    await insertObjects(service.db, ACCOUNT, seedAccounts);

    await insertObjects(service.db, ENGAGEMENT, seedEngagements);

    const edits: Edit[] = [
      ...Array.from({ length: count }, (_, index) =>
        addEdit(ACCOUNT, `created-${String(index).padStart(3, '0')}`, { name: `Created ${index}`, phase: 'customer' }),
      ),
      ...Array.from({ length: count }, (_, index) =>
        modifyEdit(ACCOUNT, `seed-${String(index).padStart(3, '0')}`, { name: `Modified ${index}`, phase: 'customer' }),
      ),
      ...Array.from({ length: count }, (_, index) =>
        deleteEdit(ACCOUNT, `seed-${String(index + count).padStart(3, '0')}`),
      ),
      ...Array.from({ length: 20 }, (_, index) =>
        linkEdit(
          'addLink',
          'sponsors',
          locator(ENGAGEMENT, `eng-${String(index).padStart(2, '0')}`),
          locator(ACCOUNT, `created-${String(index).padStart(3, '0')}`),
        ),
      ),
    ];

    const answer = await applyScripted(edits);

    expect(answer.status).toBe(200);

    const stored = await rowsOf(service.db, ACCOUNT, 'account_id');

    expect(stored).toHaveLength(1 + count * 2);

    const versions = new Set(stored.filter((row) => row['account_id'] !== 'anchor').map((row) => row['__version']));

    expect(versions.size).toBe(count * 2);

    expect(await historyCount()).toBe(count * 3);

    const links = await service.db.query<{ a_engagement_id: string; b_account_id: string }>(
      sql('SELECT a_engagement_id, b_account_id FROM ontology_1_objects.engagement_sponsors ORDER BY a_engagement_id'),
    );

    expect(links).toHaveLength(20);
  });

  it('service/storage#writes: batched creates and heterogeneous modifies preserve every column type, null, struct default, and array shape', async () => {
    const createEdits: Edit[] = [
      addEdit(BATCH_PROBE, 'bp-1', {
        name: 'NULL,{},"q"\\bs,é',
        flag: true,
        count: 42,
        ratio: 3.25,
        amount: '1234.50',
        day: '2026-03-15',
        occurredAt: '2026-03-15T12:34:56.789Z',
        details: { label: 'alpha', price: '19.95' },
        tags: ['NULL', 'a,b', 'c"d', 'e\\f', '{}'],
        flags: [true, false],
        counts: [1, -2, 300],
        ratios: [0.5, -1.25],
        amounts: ['10.00', '20.50'],
        days: ['2026-01-01', '2026-12-31'],
        timestamps: ['2026-01-01T00:00:00Z', '2026-06-15T08:30:00Z'],
      }),
      addEdit(BATCH_PROBE, 'bp-2', {
        name: 'Omitted Struct',
        flag: false,
        count: 0,
        ratio: 0,
        amount: '0.00',
        day: '2026-04-01',
        occurredAt: '2026-04-01T00:00:00Z',
        tags: [],
        flags: [],
        counts: [7],
        ratios: [],
        amounts: [],
        days: [],
        timestamps: [],
      }),
      addEdit(BATCH_PROBE, 'bp-3', {
        name: 'Explicit Nulls',
        flag: null,
        count: null,
        ratio: null,
        amount: null,
        day: null,
        occurredAt: null,
        details: null,
        tags: null,
        flags: null,
        counts: null,
        ratios: null,
        amounts: null,
        days: null,
        timestamps: null,
      }),
    ];

    expect((await applyScripted(createEdits)).status).toBe(200);

    const loaded = await service.loadObjects({
      objectSet: { type: 'base', objectType: BATCH_PROBE },
      orderBy: { fields: [{ field: 'accountId', direction: 'asc' }] },
    });

    expect(loaded.status).toBe(200);

    const items = (loaded.body as { data: Record<string, unknown>[] }).data;

    expect(items).toEqual([
      expect.objectContaining({
        accountId: 'bp-1',
        name: 'NULL,{},"q"\\bs,é',
        flag: true,
        count: 42,
        ratio: 3.25,
        amount: '1234.50',
        day: '2026-03-15',
        occurredAt: '2026-03-15T12:34:56.789Z',
        details: { label: 'alpha', price: '19.95' },
        tags: ['NULL', 'a,b', 'c"d', 'e\\f', '{}'],
        flags: [true, false],
        counts: [1, -2, 300],
        ratios: [0.5, -1.25],
        amounts: ['10.00', '20.50'],
        days: ['2026-01-01', '2026-12-31'],
        timestamps: ['2026-01-01T00:00:00Z', '2026-06-15T08:30:00Z'],
      }),
      expect.objectContaining({
        accountId: 'bp-2',
        name: 'Omitted Struct',
        flag: false,
        count: 0,
        ratio: 0,
        amount: '0.00',
        day: '2026-04-01',
        occurredAt: '2026-04-01T00:00:00Z',
        details: {},
        tags: [],
        flags: [],
        counts: [7],
        ratios: [],
        amounts: [],
        days: [],
        timestamps: [],
      }),
      expect.objectContaining({
        accountId: 'bp-3',
        name: 'Explicit Nulls',
      }),
    ]);

    expect(items[2]).not.toHaveProperty('details');
    expect(items[2]).not.toHaveProperty('tags');

    const modifyEdits: Edit[] = [
      modifyEdit(BATCH_PROBE, 'bp-1', { count: 99, details: null, tags: ['only-one'] }),
      modifyEdit(BATCH_PROBE, 'bp-2', { amount: '55.25', details: { label: 'filled', price: '2.00' }, counts: null }),
      modifyEdit(BATCH_PROBE, 'bp-3', { flag: true, amounts: ['99.99'], days: ['2026-05-05'] }),
    ];

    expect((await applyScripted(modifyEdits)).status).toBe(200);

    const afterModify = await service.loadObjects({
      objectSet: { type: 'base', objectType: BATCH_PROBE },
      orderBy: { fields: [{ field: 'accountId', direction: 'asc' }] },
    });

    const updated = (afterModify.body as { data: Record<string, unknown>[] }).data;

    expect(updated[0]).toEqual(
      expect.objectContaining({
        accountId: 'bp-1',
        name: 'NULL,{},"q"\\bs,é',
        flag: true,
        count: 99,
        amount: '1234.50',
        tags: ['only-one'],
      }),
    );

    expect(updated[0]).not.toHaveProperty('details');

    expect(updated[1]).toEqual(
      expect.objectContaining({
        accountId: 'bp-2',
        name: 'Omitted Struct',
        count: 0,
        amount: '55.25',
        details: { label: 'filled', price: '2.00' },
        tags: [],
      }),
    );

    expect(updated[1]).not.toHaveProperty('counts');

    expect(updated[2]).toEqual(
      expect.objectContaining({
        accountId: 'bp-3',
        name: 'Explicit Nulls',
        flag: true,
        amounts: ['99.99'],
        days: ['2026-05-05'],
      }),
    );

    expect(updated[2]).not.toHaveProperty('details');
  });

  it('service/storage#writes: 1 duplicate primary key in a 50-row create batch returns 409 ObjectAlreadyExists and rolls back every edit', async () => {
    await insertObjects(service.db, ACCOUNT, [
      account('dup-25', 'Existing', 'customer'),
      account('keep-1', 'Original', 'prospect'),
      account('keep-2', 'Still Here', 'prospect'),
    ]);

    const edits: Edit[] = [
      ...Array.from({ length: 50 }, (_, index) =>
        addEdit(ACCOUNT, `dup-${String(index).padStart(2, '0')}`, { name: `New ${index}` }),
      ),
      modifyEdit(ACCOUNT, 'keep-1', { name: 'Should Roll Back' }),
      deleteEdit(ACCOUNT, 'keep-2'),
    ];

    const answer = await applyScripted(edits);

    expect(errorAnswer(answer)).toEqual({
      status: 409,
      body: { errorCode: 'CONFLICT', errorName: 'ObjectAlreadyExists', parameters: {} },
    });

    const stored = await rowsOf(service.db, ACCOUNT, 'account_id');

    expect(stored.map((row) => [row['account_id'], row['name']])).toEqual([
      ['anchor', 'Anchor'],
      ['dup-25', 'Existing'],
      ['keep-1', 'Original'],
      ['keep-2', 'Still Here'],
    ]);

    expect(await historyCount()).toBe(0);
  });

  it('service/storage#writes: 1 concurrently changed row in a 20-row batched modify returns 409 ObjectChanged and writes nothing', async () => {
    const keys = Array.from({ length: 20 }, (_, index) => `chg-${String(index).padStart(2, '0')}`);

    await insertObjects(
      service.db,
      ACCOUNT,
      keys.map((key, index) => account(key, `Before ${index}`, 'prospect')),
    );

    let raced = false;

    const racing: Db = {
      ...service.db,
      transaction: async (run) => {
        if (!raced) {
          raced = true;

          await service.db.query(
            sql(
              "UPDATE ontology_1_objects.account SET name = 'Raced', __version = __version + 1 WHERE account_id = 'chg-13'",
            ),
          );
        }

        return service.db.transaction(run);
      },
    };

    const edits = keys.map((key, index) => modifyEdit(ACCOUNT, key, { name: `After ${index}` }));

    const answer = await applyScripted(edits, racing);

    expect(errorAnswer(answer)).toEqual({
      status: 409,
      body: { errorCode: 'CONFLICT', errorName: 'ObjectChanged', parameters: {} },
    });

    const stored = await rowsOf(service.db, ACCOUNT, 'account_id');

    expect(stored.find((row) => row['account_id'] === 'chg-13')?.['name']).toBe('Raced');
    expect(stored.find((row) => row['account_id'] === 'chg-00')?.['name']).toBe('Before 0');

    expect(await historyCount()).toBe(0);
  });

  it('service/storage#writes: a row locked and changed by another transaction while a batched lock waits returns 409 ObjectChanged and writes nothing', async () => {
    const keys = Array.from({ length: 10 }, (_, index) => `wait-${String(index).padStart(2, '0')}`);

    await insertObjects(
      service.db,
      ACCOUNT,
      keys.map((key, index) => account(key, `Before ${index}`, 'prospect')),
    );

    const holder = new pg.Client({ connectionString: service.url });

    await holder.connect();

    try {
      await holder.query('BEGIN');

      await holder.query("SELECT 1 FROM ontology_1_objects.account WHERE account_id = 'wait-05' FOR UPDATE");

      const edits = keys.map((key, index) => modifyEdit(ACCOUNT, key, { name: `After ${index}` }));
      let started!: () => void;

      const lockStarted = new Promise<void>((resolve) => {
        started = resolve;
      });

      const watching: Db = {
        ...service.db,
        transaction: (run) =>
          service.db.transaction((tx) =>
            run({
              ...tx,
              query: <Row extends object>(statement: Sql) => {
                if (statement.text.includes('FOR UPDATE')) started();

                return tx.query<Row>(statement);
              },
            }),
          ),
      };

      const pending = applyScripted(edits, watching);

      await lockStarted;

      await holder.query(
        "UPDATE ontology_1_objects.account SET name = 'Winner', __version = __version + 1 WHERE account_id = 'wait-05'",
      );

      await holder.query('COMMIT');

      const answer = await pending;

      expect(errorAnswer(answer)).toEqual({
        status: 409,
        body: { errorCode: 'CONFLICT', errorName: 'ObjectChanged', parameters: {} },
      });

      const stored = await rowsOf(service.db, ACCOUNT, 'account_id');

      expect(stored.find((row) => row['account_id'] === 'wait-05')?.['name']).toBe('Winner');
      expect(stored.find((row) => row['account_id'] === 'wait-00')?.['name']).toBe('Before 0');

      expect(await historyCount()).toBe(0);
    } finally {
      await holder.end();
    }
  });

  it('service/storage#writes: a batched lock that waits past the transaction deadline returns 400 ActionDeadlineExceeded and writes nothing', async () => {
    const keys = Array.from({ length: 10 }, (_, index) => `dl-${String(index).padStart(2, '0')}`);

    await insertObjects(
      service.db,
      ACCOUNT,
      keys.map((key, index) => account(key, `Before ${index}`, 'prospect')),
    );

    vi.useFakeTimers({ toFake: ['Date'] });

    const start = Date.now();

    vi.setSystemTime(start);

    const holder = new pg.Client({ connectionString: service.url });

    await holder.connect();

    try {
      await holder.query('BEGIN');

      await holder.query("SELECT 1 FROM ontology_1_objects.account WHERE account_id = 'dl-07' FOR UPDATE");

      const slowClockDb: Db = {
        ...service.db,
        transaction: (run) => {
          vi.setSystemTime(start + 119_700);

          return service.db.transaction(run);
        },
      };

      const edits = keys.map((key, index) => modifyEdit(ACCOUNT, key, { name: `After ${index}` }));

      const answer = await applyScripted(edits, slowClockDb);

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: { errorCode: 'INVALID_ARGUMENT', errorName: 'ActionDeadlineExceeded', parameters: {} },
      });

      expect(await historyCount()).toBe(0);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);

      await holder.end();
    }
  });

  it('service/storage#writes: a deadlock 40P01 on a batched lock retries a rule-backed Action and commits when the next attempt succeeds', async () => {
    await insertObjects(service.db, ACCOUNT, [
      account('dlk-1', 'One', 'prospect'),
      account('dlk-2', 'Two', 'prospect'),
    ]);

    const pool = createPool(service.url, { max: 1 });
    const connect = pool.connect.bind(pool);
    let deadlocks = 0;

    const patched = async () => {
      const client = await connect();

      const query = client.query.bind(client) as (text: unknown, values?: unknown) => Promise<unknown>;

      return Object.assign(client, {
        query: async (text: unknown, values?: unknown) => {
          if (typeof text === 'string' && text.includes('FOR UPDATE') && deadlocks === 0) {
            deadlocks += 1;

            return query("DO $$ BEGIN RAISE EXCEPTION 'simulated deadlock' USING ERRCODE = '40P01'; END $$");
          }

          return query(text, values);
        },
      });
    };

    const db = createDb(Object.assign(pool, { connect: patched }));

    try {
      const answer = await service.apply(
        MODIFY_TWO,
        { parameters: { first: 'dlk-1', second: 'dlk-2', name: 'Retried' }, options: EXECUTE_NONE },
        { db },
      );

      expect(answer.status).toBe(200);
      expect(deadlocks).toBe(1);

      const stored = await rowsOf(service.db, ACCOUNT, 'account_id');

      expect(
        stored.filter((row) => row['account_id'] !== 'anchor').map((row) => [row['account_id'], row['name']]),
      ).toEqual([
        ['dlk-1', 'Retried'],
        ['dlk-2', 'Retried'],
      ]);
    } finally {
      await pool.end();
    }
  });

  it('service/storage#writes: mixed FOR UPDATE and FOR KEY SHARE locks on the same Object Type stay in deterministic primaryKey order', async () => {
    await insertObjects(service.db, ACCOUNT, [
      account('k-1', 'One', 'prospect'),
      account('k-2', 'Two', 'prospect'),
      account('k-3', 'Three', 'prospect'),
    ]);

    await insertObjects(service.db, ENGAGEMENT, [engagement('e-1', 'k-1', 'Eng 1', 100, 'open', null)]);

    const lockStatements: { text: string; values: readonly unknown[] }[] = [];

    const watching: Db = {
      ...service.db,
      transaction: (run) =>
        service.db.transaction((tx) =>
          run({
            ...tx,
            query: <Row extends object>(statement: Sql) => {
              if (/ FOR (UPDATE|KEY SHARE)/.test(statement.text))
                lockStatements.push({ text: statement.text, values: statement.values });

              return tx.query<Row>(statement);
            },
          }),
        ),
    };

    const edits: Edit[] = [
      modifyEdit(ACCOUNT, 'k-3', { name: 'Three Updated' }),
      modifyEdit(ACCOUNT, 'k-1', { name: 'One Updated' }),
      linkEdit('addLink', 'peers', locator(ACCOUNT, 'k-1'), locator(ACCOUNT, 'k-2')),
      linkEdit('addLink', 'sponsors', locator(ENGAGEMENT, 'e-1'), locator(ACCOUNT, 'k-2')),
    ];

    expect((await applyScripted(edits, watching)).status).toBe(200);

    const acquired = lockStatements.map((statement) => ({
      table: statement.text.match(/FROM (\S+)/)?.[1],
      mode: statement.text.match(/FOR (UPDATE|KEY SHARE)/)?.[1],
      keys: Array.isArray(statement.values[0]) ? statement.values[0] : [statement.values[0]],
    }));

    expect(acquired).toEqual([
      { table: '"ontology_1_objects"."account"', mode: 'UPDATE', keys: ['k-1'] },
      { table: '"ontology_1_objects"."account"', mode: 'KEY SHARE', keys: ['k-2'] },
      { table: '"ontology_1_objects"."account"', mode: 'UPDATE', keys: ['k-3'] },
      { table: '"ontology_1_objects"."engagement"', mode: 'KEY SHARE', keys: ['e-1'] },
    ]);
  });

  it('service/storage#writes: alternating addLink and deleteLink edits on 1 join table keep their relative order', async () => {
    await insertObjects(service.db, ACCOUNT, [account('a-1', 'One', 'customer'), account('a-2', 'Two', 'customer')]);

    await insertObjects(service.db, ENGAGEMENT, [engagement('e-1', 'a-1', 'Eng 1', 100, 'open', null)]);

    await service.db.query(
      sql("INSERT INTO ontology_1_objects.engagement_sponsors (a_engagement_id, b_account_id) VALUES ('e-1', 'a-2')"),
    );

    const edits: Edit[] = [
      linkEdit('addLink', 'sponsors', locator(ENGAGEMENT, 'e-1'), locator(ACCOUNT, 'a-1')),
      linkEdit('deleteLink', 'sponsors', locator(ENGAGEMENT, 'e-1'), locator(ACCOUNT, 'a-1')),
      linkEdit('deleteLink', 'sponsors', locator(ENGAGEMENT, 'e-1'), locator(ACCOUNT, 'a-2')),
      linkEdit('addLink', 'sponsors', locator(ENGAGEMENT, 'e-1'), locator(ACCOUNT, 'a-2')),
    ];

    expect((await applyScripted(edits)).status).toBe(200);

    const links = await service.db.query<{ a_engagement_id: string; b_account_id: string }>(
      sql('SELECT a_engagement_id, b_account_id FROM ontology_1_objects.engagement_sponsors ORDER BY b_account_id'),
    );

    expect(links).toEqual([{ a_engagement_id: 'e-1', b_account_id: 'a-2' }]);
  });

  it('service/storage#writes: a 1,000-row bulk create applies in 4 SQL statements inside the write transaction', async () => {
    const count = 1000;

    const edits: Edit[] = Array.from({ length: count }, (_, index) =>
      addEdit(ACCOUNT, `bulk-${String(index).padStart(4, '0')}`, { name: `Bulk ${index}`, phase: 'customer' }),
    );

    let txQueries = 0;

    const counting: Db = {
      ...service.db,
      transaction: (run) =>
        service.db.transaction((tx) =>
          run({
            ...tx,
            query: <Row extends object>(statement: Sql) => {
              txQueries += 1;

              return tx.query<Row>(statement);
            },
          }),
        ),
    };

    const answer = await applyScripted(edits, counting);

    expect(answer.status).toBe(200);
    expect(txQueries).toBe(4);

    const [row] = await service.db.query<{ count: number }>(
      sql('SELECT count(*)::int AS count FROM ontology_1_objects.account'),
    );

    expect(row?.count).toBe(1 + count);
  });

  it('deduplicates and parallelizes snapshot version reads across edited and linked Object Types', async () => {
    await insertObjects(service.db, ACCOUNT, [account('dup-a', 'Before', 'prospect')]);

    await insertObjects(service.db, ENGAGEMENT, [engagement('dup-e', 'dup-a', 'Eng', 10, 'open', null)]);

    const snapshotQueries: string[] = [];

    const watching: Db = {
      ...service.db,
      snapshot: (run) =>
        service.db.snapshot((snapshot) =>
          run({
            ...snapshot,
            query: <Row extends object>(statement: Sql) => {
              snapshotQueries.push(statement.text);

              return snapshot.query<Row>(statement);
            },
          } as typeof snapshot),
        ),
    };

    const edits: Edit[] = [
      modifyEdit(ACCOUNT, 'dup-a', { name: 'After' }),
      linkEdit('addLink', 'sponsors', locator(ENGAGEMENT, 'dup-e'), locator(ACCOUNT, 'dup-a')),
    ];

    expect((await applyScripted(edits, watching)).status).toBe(200);

    const accountReads = snapshotQueries.filter((q) => q.includes('"account"') && q.includes('__version'));
    const engagementReads = snapshotQueries.filter((q) => q.includes('"engagement"') && q.includes('__version'));

    expect(accountReads).toHaveLength(1);
    expect(engagementReads).toHaveLength(1);
  });
});
