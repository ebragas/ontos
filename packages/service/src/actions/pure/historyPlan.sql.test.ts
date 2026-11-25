import { afterAll, beforeAll, expect, it } from 'vitest';
import { historySql, readHistoryRequest } from './history.ts';
import { bindReader } from '../../db/index.ts';
import { orThrow } from '../../errors/fallible.ts';
import { insertObjects, NS, startActions, twinFunctions, type ActionsService } from '../actions.test-utils.ts';
import { compileOrThrow, policiesIr, stored, twinIr, unchecked, USE } from '../../ontology/stored.test-utils.ts';
import { groupGrants } from '../../policiesPeople.test-utils.ts';

import { sql } from '../../publish/publish.test-utils.ts';
import { UserId } from '../../auth/caller.ts';

const ACCOUNT = `${NS}Account`;
let service: ActionsService;

function historyIr() {
  const ir = policiesIr();
  const account = ir.ontology.objectTypes[ACCOUNT];

  if (!account) throw new Error('The policies IR has no Account.');

  account.entityMetadata = unchecked({
    ...account.entityMetadata,
    editsHistory: { type: 'config', config: { store: ACCOUNT, storeAllPreviousProperties: true } },
  });

  return ir;
}

beforeAll(async () => {
  const ir = historyIr();

  service = await startActions(
    ir,
    twinFunctions('0.6.3'),
    groupGrants(ir, { admin: ['ontology:install', USE, 'admin'], member: [USE, 'member'], guest: [USE] }),
  );

  const live = Array.from({ length: 1250 }, (_, i) => `live-${String(i).padStart(5, '0')}`);
  const gone = Array.from({ length: 1250 }, (_, i) => `gone-${String(i).padStart(5, '0')}`);
  const owner = (i: number) => (i % 10 === 0 ? 'user_ann' : 'user_ben');

  await insertObjects(
    service.db,
    ACCOUNT,
    live.map((accountId, i) => ({
      accountId,
      name: accountId,
      phase: 'customer',
      ownerId: owner(i),
      viewers: ['reviewer'],
    })),
  );

  const entry = (type: string, ownerId: string) =>
    JSON.stringify({
      operationId: 'op',
      userId: 'user_admin',
      edit: { type, previousProperties: { ownerId, viewers: ['reviewer'] } },
    });

  const rows: [string, string, string][] = [];

  live.forEach((key, i) =>
    rows.push(
      [key, entry('createEdit', owner(i)), `-${i * 2} seconds`],
      [key, entry('modifyEdit', owner(i)), `-${i * 2 + 1} seconds`],
    ),
  );

  gone.forEach((key, i) =>
    rows.push(
      [key, entry('createEdit', owner(i)), `-${i * 2} seconds`],
      [key, entry('deleteEdit', owner(i)), `-${i * 2 + 1} seconds`],
    ),
  );

  await service.db.query(
    sql(
      'INSERT INTO ontology_1_engine.edit_history (object_type, primary_key, entry, created_at) SELECT $1, k, e::jsonb, now() + d::interval FROM unnest($2::text[], $3::text[], $4::text[]) AS t(k, e, d)',
      ACCOUNT,
      rows.map((r) => r[0]),
      rows.map((r) => r[1]),
      rows.map((r) => r[2]),
    ),
  );

  await service.db.query(sql('ANALYZE ontology_1_engine.edit_history'));

  await service.db.query(sql('ANALYZE ontology_1_objects.account'));
});

afterAll(() => service?.stop());

function loopsOf(plan: unknown, relation: string): number[] {
  if (Array.isArray(plan)) return plan.flatMap((node) => loopsOf(node, relation));

  if (typeof plan !== 'object' || plan === null) return [];

  const node = plan as Record<string, unknown>;
  const own = node['Relation Name'] === relation ? [Number(node['Actual Loops'])] : [];

  return [...own, ...Object.values(node).flatMap((value) => loopsOf(value, relation))];
}

function workersOf(plan: unknown): number {
  if (Array.isArray(plan)) return Math.max(0, ...plan.map(workersOf));

  if (typeof plan !== 'object' || plan === null) return 0;

  const node = plan as Record<string, unknown>;

  return Math.max(Number(node['Workers Launched'] ?? 0), ...Object.values(node).map(workersOf));
}

const PARALLEL = [
  'SET LOCAL parallel_setup_cost = 0',
  'SET LOCAL parallel_tuple_cost = 0',
  'SET LOCAL min_parallel_table_scan_size = 0',
  'SET LOCAL max_parallel_workers_per_gather = 2',
];

it.each([
  ['the first page', {}, [], 0],
  ['the first page, oldest first', { sortOrder: 'oldest_first' }, [], 0],
  ['the page of a deleted Object', { objectPrimaryKey: { accountId: 'gone-00010' } }, [], 0],
  ['the first page, in a parallel plan', {}, PARALLEL, 1],
] as const)(
  'the history read of %s scans each table a fixed number of times, not 1 time for each entry',
  async (_name, body, settings, minWorkers) => {
    const ontology = compileOrThrow(stored(historyIr(), { functions: twinFunctions('0.6.3') }));
    const objectType = ontology.objectTypes.get(ACCOUNT);

    if (!objectType) throw new Error('The policies IR has no Account.');

    const { reader } = bindReader(
      { object: 'ontology_1_objects', engine: 'ontology_1_engine' },
      { userId: UserId.parse('user_ann'), permissions: [USE, 'member'], attributes: new Map() },
    );

    const query = historySql(reader, objectType, orThrow(readHistoryRequest(body, objectType)));

    const [explained] = await service.db.transaction(async (tx) => {
      for (const setting of settings) await tx.query(sql(setting));

      return tx.query<{ 'QUERY PLAN': unknown }>({
        text: `EXPLAIN (ANALYZE, FORMAT JSON) ${query.text}`,
        values: query.values,
      });
    });

    const plan = explained?.['QUERY PLAN'];
    const scans = [...loopsOf(plan, 'account'), ...loopsOf(plan, 'edit_history')];

    expect(loopsOf(plan, 'account').length).toBeGreaterThan(0);
    expect(loopsOf(plan, 'edit_history').length).toBeGreaterThan(0);

    const workers = workersOf(plan);

    expect(workers).toBeGreaterThanOrEqual(minWorkers);

    expect(Math.max(...scans)).toBeLessThanOrEqual(1 + workers);
  },
);

function indexNamesOf(plan: unknown): string[] {
  if (Array.isArray(plan)) return plan.flatMap(indexNamesOf);

  if (typeof plan !== 'object' || plan === null) return [];

  const node = plan as Record<string, unknown>;
  const own = typeof node['Index Name'] === 'string' ? [node['Index Name']] : [];

  return [...own, ...Object.values(node).flatMap(indexNamesOf)];
}

it('creates edit_history composite indexes and uses them in EXPLAIN for whole-type and per-object history lookups', async () => {
  const indexes = await service.db.query<{ indexname: string }>(
    sql(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'ontology_1_engine' AND tablename = 'edit_history' ORDER BY indexname",
    ),
  );

  expect(indexes).toEqual([
    { indexname: 'edit_history_type_created_pk_idx' },
    { indexname: 'edit_history_type_pk_created_idx' },
  ]);

  const plainIr = twinIr('0.6.3');
  const plainAccount = plainIr.ontology.objectTypes[ACCOUNT];

  if (!plainAccount) throw new Error('The twin IR has no Account.');

  plainAccount.entityMetadata = unchecked({
    ...plainAccount.entityMetadata,
    editsHistory: { type: 'config', config: { store: ACCOUNT, storeAllPreviousProperties: true } },
  });

  const ontology = compileOrThrow(stored(plainIr, { functions: twinFunctions('0.6.3') }));
  const objectType = ontology.objectTypes.get(ACCOUNT);

  if (!objectType) throw new Error('The compiled twin ontology has no Account.');

  const { reader } = bindReader(
    { object: 'ontology_1_objects', engine: 'ontology_1_engine' },
    { userId: UserId.parse('user_ann'), permissions: [USE], attributes: new Map() },
  );

  const wholeType = historySql(reader, objectType, orThrow(readHistoryRequest({ pageSize: 20 }, objectType)));

  const [wholePlan] = await service.db.transaction(async (tx) => {
    await tx.query(sql('SET LOCAL enable_seqscan = off'));

    return tx.query<{ 'QUERY PLAN': unknown }>({
      text: `EXPLAIN (FORMAT JSON) ${wholeType.text}`,
      values: wholeType.values,
    });
  });

  expect(indexNamesOf(wholePlan?.['QUERY PLAN'])).toContain('edit_history_type_created_pk_idx');

  const perObject = historySql(
    reader,
    objectType,
    orThrow(readHistoryRequest({ objectPrimaryKey: { accountId: 'live-00010' }, pageSize: 20 }, objectType)),
  );

  const [objectPlan] = await service.db.transaction(async (tx) => {
    await tx.query(sql('SET LOCAL enable_seqscan = off'));

    return tx.query<{ 'QUERY PLAN': unknown }>({
      text: `EXPLAIN (FORMAT JSON) ${perObject.text}`,
      values: perObject.values,
    });
  });

  expect(indexNamesOf(objectPlan?.['QUERY PLAN'])).toContain('edit_history_type_pk_created_idx');
});

function indexScansOf(plan: unknown): { readonly index: string; readonly cond: string }[] {
  if (Array.isArray(plan)) return plan.flatMap(indexScansOf);

  if (typeof plan !== 'object' || plan === null) return [];

  const node = plan as Record<string, unknown>;

  const own =
    typeof node['Index Name'] === 'string'
      ? [{ index: node['Index Name'], cond: typeof node['Index Cond'] === 'string' ? node['Index Cond'] : '' }]
      : [];

  return [...own, ...Object.values(node).flatMap(indexScansOf)];
}

it('uses edit_history_type_created_pk_idx as a B-tree Index Cond on created_at for timestampFilter queries', async () => {
  const plainIr = twinIr('0.6.3');
  const plainAccount = plainIr.ontology.objectTypes[ACCOUNT];

  if (!plainAccount) throw new Error('The twin IR has no Account.');

  plainAccount.entityMetadata = unchecked({
    ...plainAccount.entityMetadata,
    editsHistory: { type: 'config', config: { store: ACCOUNT, storeAllPreviousProperties: true } },
  });

  const ontology = compileOrThrow(stored(plainIr, { functions: twinFunctions('0.6.3') }));
  const objectType = ontology.objectTypes.get(ACCOUNT);

  if (!objectType) throw new Error('The compiled twin ontology has no Account.');

  const { reader } = bindReader(
    { object: 'ontology_1_objects', engine: 'ontology_1_engine' },
    { userId: UserId.parse('user_ann'), permissions: [USE], attributes: new Map() },
  );

  const rangeQuery = historySql(
    reader,
    objectType,
    orThrow(
      readHistoryRequest(
        {
          filters: {
            type: 'timestampFilter',
            startTime: '2026-01-01T00:00:00.123Z',
            endTime: '2026-12-31T23:59:59.456Z',
          },
          pageSize: 20,
        },
        objectType,
      ),
    ),
  );

  expect(rangeQuery.text).not.toContain("date_trunc('milliseconds', created_at)");

  const [plan] = await service.db.transaction(async (tx) => {
    await tx.query(sql('SET LOCAL enable_seqscan = off'));

    return tx.query<{ 'QUERY PLAN': unknown }>({
      text: `EXPLAIN (FORMAT JSON) ${rangeQuery.text}`,
      values: rangeQuery.values,
    });
  });

  const scan = indexScansOf(plan?.['QUERY PLAN']).find((entry) => entry.index === 'edit_history_type_created_pk_idx');

  expect(scan).toBeDefined();
  expect(scan?.cond).toContain('created_at >=');
  expect(scan?.cond).toContain('created_at <');
});

it('matches date_trunc millisecond semantics across sub-millisecond, timezone, and pre-1970 boundaries', async () => {
  const plainIr = twinIr('0.6.3');
  const plainAccount = plainIr.ontology.objectTypes[ACCOUNT];

  if (!plainAccount) throw new Error('The twin IR has no Account.');

  plainAccount.entityMetadata = unchecked({
    ...plainAccount.entityMetadata,
    editsHistory: { type: 'config', config: { store: ACCOUNT, storeAllPreviousProperties: true } },
  });

  const ontology = compileOrThrow(stored(plainIr, { functions: twinFunctions('0.6.3') }));
  const objectType = ontology.objectTypes.get(ACCOUNT);

  if (!objectType) throw new Error('The compiled twin ontology has no Account.');

  const { reader } = bindReader(
    { object: 'ontology_1_objects', engine: 'ontology_1_engine' },
    { userId: UserId.parse('user_ann'), permissions: [USE], attributes: new Map() },
  );

  const samples: readonly (readonly [string, string])[] = [
    ['ms-before-999', '2026-06-15T12:00:00.122999Z'],
    ['ms-exact-000', '2026-06-15T12:00:00.123000Z'],
    ['ms-plus-001', '2026-06-15T12:00:00.123001Z'],
    ['ms-mid-456', '2026-06-15T12:00:00.123456Z'],
    ['ms-end-999', '2026-06-15T12:00:00.123999Z'],
    ['ms-next-000', '2026-06-15T12:00:00.124000Z'],
    ['pre1970-000', '1969-12-31T23:59:59.123000Z'],
    ['pre1970-456', '1969-12-31T23:59:59.123456Z'],
    ['pre1970-999', '1969-12-31T23:59:59.123999Z'],
    ['pre1970-next', '1969-12-31T23:59:59.124000Z'],
  ];

  await service.db.query(
    sql(
      'INSERT INTO ontology_1_engine.edit_history (object_type, primary_key, entry, created_at) SELECT $1, k, $2::jsonb, t::timestamptz FROM unnest($3::text[], $4::text[]) AS r(k, t)',
      ACCOUNT,
      JSON.stringify({ operationId: 'op-ms', userId: 'user_admin', edit: { type: 'createEdit', properties: {} } }),
      samples.map(([k]) => k),
      samples.map(([, t]) => t),
    ),
  );

  const cases: readonly { readonly startTime?: string; readonly endTime?: string }[] = [
    { startTime: '2026-06-15T12:00:00.123Z', endTime: '2026-06-15T12:00:00.123Z' },
    { startTime: '2026-06-15T14:00:00.123+02:00', endTime: '2026-06-15T14:00:00.123+02:00' },
    { startTime: '2026-06-15T12:00:00.123001Z', endTime: '2026-06-15T12:00:00.124000Z' },
    { startTime: '2026-06-15T12:00:00.123456Z', endTime: '2026-06-15T12:00:00.123456Z' },
    { startTime: '2026-06-15T12:00:00.122999Z', endTime: '2026-06-15T12:00:00.123456Z' },
    { startTime: '1969-12-31T23:59:59.123Z', endTime: '1969-12-31T23:59:59.123Z' },
    { startTime: '1969-12-31T23:59:59.123001Z', endTime: '1969-12-31T23:59:59.124Z' },
  ];

  const sampleKeys = new Set(samples.map(([k]) => k));

  for (const filter of cases) {
    const query = historySql(
      reader,
      objectType,
      orThrow(readHistoryRequest({ filters: { type: 'timestampFilter', ...filter }, pageSize: 100 }, objectType)),
    );

    const actual = (await service.db.query<{ primaryKey: string }>(query))
      .map((row) => row.primaryKey)
      .filter((key) => sampleKeys.has(key))
      .sort();

    const refConditions = ['object_type = $1', 'primary_key = ANY($2::text[])'];
    const refValues: unknown[] = [ACCOUNT, [...sampleKeys]];

    if (filter.startTime !== undefined)
      refConditions.push(`date_trunc('milliseconds', created_at) >= $${refValues.push(filter.startTime)}::timestamptz`);

    if (filter.endTime !== undefined)
      refConditions.push(`date_trunc('milliseconds', created_at) <= $${refValues.push(filter.endTime)}::timestamptz`);

    const expected = (
      await service.db.query<{ primary_key: string }>({
        text: `SELECT primary_key FROM ontology_1_engine.edit_history WHERE ${refConditions.join(' AND ')} ORDER BY primary_key`,
        values: refValues,
      })
    ).map((row) => row.primary_key);

    expect({ filter, actual }).toEqual({ filter, actual: expected });
  }
});
