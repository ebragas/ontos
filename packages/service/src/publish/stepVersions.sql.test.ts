import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it, afterEach } from 'vitest';
import { WRITE_VERSION, type Sql } from '../db/index.ts';
import type { Db } from '../db/promise.test-utils.ts';

import type { SchemaMigration } from './index.ts';
import {
  actionType,
  errorAnswer,
  newVersion,
  NS,
  ONTOLOGY_RID,
  rowsOf,
  startActions,
  twinFunctions,
  twinIr,
  type ActionsService,
} from '../actions/actions.test-utils.ts';
import { convertOrThrow, grantsOf, stored, unchecked } from '../ontology/stored.test-utils.ts';
import {
  APPLY,
  expectAllOnNewest,
  insertObjects,
  manyToManyLink,
  PUBLISHER,
  publishOntology,
  readRequest,
  sql,
  waitForLockWaits,
} from './publish.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const STRUCT_PROBE = `${NS}StructProbe`;
const SET_ACCOUNT_PHASE = `${NS}set-account-phase`;
const DELETE_ACCOUNT = `${NS}delete-account`;
const DELETE_STRUCT_PROBE = `${NS}delete-struct-probe`;
const CLOSE_ACCOUNT_ACTION = `${NS}close-account-action`;
const ADD_SPONSOR = `${NS}add-sponsor`;

const SPONSORS = manyToManyLink(
  'engagement-sponsors',
  { type: ENGAGEMENT, key: 'engagementId', side: 'sponsors' },
  { type: ACCOUNT, key: 'accountId', side: 'sponsoredEngagements' },
);

const objectParameter = (objectTypeId: string) => ({
  type: { type: 'objectReference', objectReference: { objectTypeId } },
  allowedValues: { type: 'objectQuery', objectQuery: { type: 'objectQuery', objectQuery: {} } },
  required: { type: 'required', required: {} },
});

type Ir = OntologyIr;

type Field = 'flag' | 'count' | 'score' | 'at';

const EXPERIMENTAL = { type: 'experimental', experimental: {} };

interface Shape {
  readonly fields: readonly Field[];
  readonly region: boolean;
  readonly probeKey: 'probeId' | 'alias';
  readonly countAsText?: boolean;
}

const BASE: Shape = { fields: ['flag', 'count'], region: false, probeKey: 'probeId' };
const NO_COUNT: Shape = { ...BASE, fields: ['flag'] };
const COUNT_AS_TEXT: Shape = { ...BASE, countAsText: true };

const STRUCT_DROPS = [
  ['a deleted struct field', NO_COUNT],
  ['a struct field with a new base type', COUNT_AS_TEXT],
] as const;

const TEXT_FIELD = {
  type: 'string',
  string: { isLongText: false, supportsEfficientLeadingWildcard: false, supportsExactMatching: true },
};

function irOf({ fields, region, probeKey, countAsText }: Shape): Ir {
  const ir = twinIr('0.6.3');
  const measures = structuredClone(ir.ontology.objectTypes[STRUCT_PROBE]?.objectType.propertyTypes['measures']);
  const account = ir.ontology.objectTypes[ACCOUNT]?.objectType;
  const phase = account?.propertyTypes['phase'];

  if (!measures || !account || !phase || measures.type.type !== 'struct')
    throw new Error('The twin 0.6.3 IR has no StructProbe measures, or no Account phase.');

  measures.type.struct.structFields = measures.type.struct.structFields
    .filter((field) => fields.includes(field.apiName as Field))
    .map((field) =>
      countAsText && field.apiName === 'count' ? { ...field, fieldType: unchecked(TEXT_FIELD) } : field,
    );

  account.propertyTypes['location'] = unchecked({ ...measures, apiName: 'location', status: EXPERIMENTAL });

  if (region) account.propertyTypes['region'] = unchecked({ ...phase, apiName: 'region', status: EXPERIMENTAL });

  const probe = ir.ontology.objectTypes[STRUCT_PROBE]?.objectType;
  const probeId = probe?.propertyTypes['probeId'];

  if (!probe || !probeId) throw new Error('The twin 0.6.3 IR has no StructProbe probeId.');

  probe.propertyTypes['alias'] = unchecked({ ...probeId, apiName: 'alias', status: EXPERIMENTAL });

  probe.primaryKeys = [probeKey];

  ir.ontology.linkTypes[SPONSORS.linkType.id] = SPONSORS;

  ir.ontology.actionTypes[ADD_SPONSOR] = actionType(
    ADD_SPONSOR,
    { engagement: objectParameter(ENGAGEMENT), account: objectParameter(ACCOUNT) },
    [
      {
        type: 'addLinkRule',
        addLinkRule: { linkTypeId: 'engagement-sponsors', sourceObject: 'engagement', targetObject: 'account' },
      },
    ],
  );

  return ir;
}

const DROP_LOCATION: SchemaMigration = { type: 'dropProperty', objectType: ACCOUNT, property: 'location' };

let service: ActionsService;
let version = 1;
let current = BASE;

beforeAll(async () => {
  service = await startActions(irOf(BASE), twinFunctions('0.6.3'));
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  if (current !== BASE) {
    await setNextPublish(BASE, []);

    await publishNext();
  }
});

afterEach(() => expectAllOnNewest(service.db));

let next: { readonly shape: Shape; readonly migrations: readonly SchemaMigration[] } | undefined;

async function setNextPublish(shape: Shape, migrations: readonly SchemaMigration[]): Promise<void> {
  current = shape;

  next = { shape, migrations };
}

async function publishNext(statements: string[] = []): Promise<string> {
  if (!next) throw new Error('No publish to run.');

  const ir = irOf(next.shape);

  const body = {
    ir,
    product: 'twin',
    schemaMigrations: { migrations: next.migrations },
    osdkSet: stored(ir).osdkSet,
    grants: grantsOf(ir),
    validateOnly: false,
    functions: twinFunctions('0.6.3'),
  };

  next = undefined;

  const request = readRequest(JSON.parse(JSON.stringify(body)) as Parameters<typeof readRequest>[0]);
  let id: string | undefined;

  const recording: Db = {
    ...service.db,
    transaction: (run) =>
      service.db.transaction(async (tx) => {
        id = (await tx.query<{ id: string }>(sql('SELECT pg_current_xact_id()::text AS id')))[0]?.id;

        return run({
          ...tx,
          query: <Row extends object>(query: Sql) => (statements.push(query.text), tx.query<Row>(query)),
        });
      }),
  };

  version += 1;

  const response = await publishOntology(recording, {
    product: 'twin',
    productRid: ONTOLOGY_RID,
    ontology: convertOrThrow(request, ONTOLOGY_RID, version),
    request,
    publisher: PUBLISHER,
    mode: APPLY,
  });

  expect(response.version).toBe(version);

  if (id === undefined) throw new Error('The publish opened no transaction.');

  return id;
}

async function upgradeTransaction(): Promise<string> {
  const [row] = await service.db.query<{ id: string }>(
    sql('SELECT xmin::text AS id FROM ontology_registry.ontologies WHERE rid = $1', ONTOLOGY_RID),
  );

  if (!row) throw new Error('No registry row.');

  return row.id;
}

async function accountXmins(): Promise<string[][]> {
  const rows = await service.db.query<{ id: string; xmin: string }>(
    sql('SELECT account_id AS id, xmin::text AS xmin FROM ontology_1_objects.account ORDER BY account_id'),
  );

  return rows.map((row) => [row.id, row.xmin]);
}

function publishingAtRead(table: string, before: () => Promise<unknown>): Db {
  let ran = false;

  const reading = async (query: Sql) => {
    if (ran || !query.text.includes(`"${table}"`)) return;

    ran = true;

    await before();
  };

  return {
    ...service.db,
    snapshot: (run) =>
      service.db.snapshot((tx) =>
        run({
          ...tx,
          query: async <Row extends object>(query: Sql) => (await reading(query), tx.query<Row>(query)),
          stream: async function* <Row extends object>(query: Sql) {
            await reading(query);

            yield* tx.stream<Row>(query);
          },
        }),
      ),
  };
}

function racingDb(before: () => Promise<unknown>): { readonly db: Db; readonly transactions: () => number } {
  let transactions = 0;

  const db: Db = {
    ...service.db,
    transaction: async (run) => {
      transactions += 1;

      if (transactions === 1) await before();

      return service.db.transaction(run);
    },
  };

  return { db, transactions: () => transactions };
}

const accounts = () => rowsOf(service.db, ACCOUNT, 'account_id');
const EXECUTE_NONE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };
const OBJECT_CHANGED = { status: 409, body: { errorCode: 'CONFLICT', errorName: 'ObjectChanged', parameters: {} } };

const OBJECT_NOT_FOUND = {
  status: 404,
  body: { errorCode: 'NOT_FOUND', errorName: 'ObjectNotFound', parameters: { primaryKey: {} } },
};

const accountRow = (accountId: string, phase: string, location: unknown, version: string) => ({
  account_id: accountId,
  name: accountId,
  phase,
  location,
  __version: version,
});

async function seed(): Promise<void> {
  await insertObjects(service.db, ACCOUNT, [
    { accountId: 'acc-1', name: 'acc-1', phase: 'prospect', location: { flag: true, count: 3 } },
    { accountId: 'acc-2', name: 'acc-2', phase: 'prospect', location: {} },
    { accountId: 'acc-3', name: 'acc-3', phase: 'prospect', location: null },
  ]);

  await insertObjects(service.db, ENGAGEMENT, [{ engagementId: 'eng-1', accountId: 'acc-1', title: 'Pilot' }]);
}

describe('the version of an Object that a step changes', () => {
  it.each(STRUCT_DROPS)(
    'service/storage#writes: the step of %s sets each struct to {}, gives each changed Object a new version in 1 statement of the upgrade transaction, and an Object at {} keeps its version',
    async (_change, shape) => {
      await seed();

      expect(await accounts()).toEqual([
        accountRow('acc-1', 'prospect', { flag: true, count: 3 }, '1'),
        accountRow('acc-2', 'prospect', {}, '1'),
        accountRow('acc-3', 'prospect', null, '1'),
      ]);

      await setNextPublish(shape, [DROP_LOCATION]);

      const before = await accountXmins();

      const statements: string[] = [];

      const id = await publishNext(statements);

      expect(id).toBe(await upgradeTransaction());

      expect(id).not.toBe('1');

      expect(await accounts()).toEqual([
        accountRow('acc-1', 'prospect', {}, newVersion('1')),
        accountRow('acc-2', 'prospect', {}, '1'),
        accountRow('acc-3', 'prospect', {}, newVersion('1')),
      ]);

      expect(await accountXmins()).toEqual([['acc-1', id], before[1], ['acc-3', id]]);

      expect((await rowsOf(service.db, ENGAGEMENT, 'engagement_id')).map((row) => row['__version'])).toEqual(['1']);

      expect(statements.filter((text) => /^(UPDATE|DELETE|INSERT)\b.*ontology_1_objects/.test(text))).toEqual([
        `UPDATE "ontology_1_objects"."account" SET "__version" = ${WRITE_VERSION}, "location" = '{}'::jsonb WHERE "location" IS DISTINCT FROM '{}'::jsonb`,
      ]);
    },
  );

  it('service/storage#writes: a step that changes no stored value, such as a new optional Property, changes no version', async () => {
    await seed();

    await setNextPublish({ ...BASE, region: true }, []);

    await publishNext();

    expect((await accounts()).map((row) => [row['account_id'], row['__version']])).toEqual([
      ['acc-1', '1'],
      ['acc-2', '1'],
      ['acc-3', '1'],
    ]);
  });
});

describe('an Action that loaded an Object before a step changed it', () => {
  it('service/storage#writes: a rule-backed modify fails the check and runs again, and the attempt again gets 409 ObjectChanged from the version read, because its view is older than the served version', async () => {
    await seed();

    await setNextPublish(NO_COUNT, [DROP_LOCATION]);

    const raced = racingDb(() => publishNext());

    const answer = await service.apply(
      SET_ACCOUNT_PHASE,
      { parameters: { objectToModifyParameter: 'acc-1', phase: 'customer' }, options: EXECUTE_NONE },
      { db: raced.db },
    );

    expect(errorAnswer(answer)).toEqual(OBJECT_CHANGED);
    expect(raced.transactions()).toBe(2);

    const [acc1] = await accounts();

    expect(acc1).toEqual(accountRow('acc-1', 'prospect', {}, newVersion('1')));
  });

  it('service/storage#writes: a rule-backed delete fails the check and runs again, and the attempt again gets 409 ObjectChanged from the version read', async () => {
    await seed();

    await setNextPublish(NO_COUNT, [DROP_LOCATION]);

    const raced = racingDb(() => publishNext());

    const answer = await service.apply(
      DELETE_ACCOUNT,
      { parameters: { objectToDeleteParameter: 'acc-1' }, options: EXECUTE_NONE },
      { db: raced.db },
    );

    expect(errorAnswer(answer)).toEqual(OBJECT_CHANGED);
    expect(raced.transactions()).toBe(2);

    expect((await accounts()).map((row) => row['account_id'])).toEqual(['acc-1', 'acc-2', 'acc-3']);
  });

  it('service/storage#writes: a rule-backed Link edit fails the lock of the changed end and runs again, and the attempt again gets 409 ObjectChanged from the version read', async () => {
    await seed();

    await setNextPublish(NO_COUNT, [DROP_LOCATION]);

    const raced = racingDb(() => publishNext());

    const answer = await service.apply(
      ADD_SPONSOR,
      { parameters: { engagement: 'eng-1', account: 'acc-1' }, options: EXECUTE_NONE },
      { db: raced.db },
    );

    expect(errorAnswer(answer)).toEqual(OBJECT_CHANGED);
    expect(raced.transactions()).toBe(2);
  });

  it('service/storage#writes: a rule-backed delete of an Object that the Drop of all Objects deletes fails the check, and the delete that runs again gets 404 ObjectNotFound', async () => {
    await insertObjects(service.db, STRUCT_PROBE, [
      { probeId: 'probe-1', alias: 'alias-1' },
      { probeId: 'probe-2', alias: 'alias-2' },
    ]);

    await setNextPublish({ ...BASE, probeKey: 'alias' }, [{ type: 'dropAllPatches', objectType: STRUCT_PROBE }]);

    const raced = racingDb(() => publishNext());

    const answer = await service.apply(
      DELETE_STRUCT_PROBE,
      { parameters: { objectToDeleteParameter: 'probe-1' }, options: EXECUTE_NONE },
      { db: raced.db },
    );

    expect(errorAnswer(answer)).toEqual(OBJECT_NOT_FOUND);
    expect(raced.transactions()).toBe(1);

    expect(await rowsOf(service.db, STRUCT_PROBE, 'probe_id')).toEqual([]);
  });

  it('service/storage#writes: a function-backed modify gets 409 ObjectChanged, and the Object keeps the values of the step', async () => {
    await seed();

    await setNextPublish(NO_COUNT, [DROP_LOCATION]);

    const db = publishingAtRead('engagement', () => publishNext());

    expect(
      errorAnswer(
        await service.apply(CLOSE_ACCOUNT_ACTION, { parameters: { account: 'acc-1' }, options: EXECUTE_NONE }, { db }),
      ),
    ).toEqual(OBJECT_CHANGED);

    const [acc1] = await accounts();

    expect(acc1).toEqual(accountRow('acc-1', 'prospect', {}, newVersion('1')));
  });

  it('service/storage#writes: the check of a rule-backed modify that overlaps the upgrade transaction waits for its commit, then fails and runs again, and the attempt again gets 409 ObjectChanged from the version read', async () => {
    await seed();

    await setNextPublish(NO_COUNT, [DROP_LOCATION]);

    const released = Promise.withResolvers<undefined>();
    const held = Promise.withResolvers<undefined>();

    const blocker = service.db.transaction(async (tx) => {
      await tx.query(sql("SELECT 1 FROM ontology_1_objects.account WHERE account_id = 'acc-3' FOR UPDATE"));

      held.resolve(undefined);

      await released.promise;
    });

    await held.promise;

    const upgrading = publishNext();

    await waitForLockWaits(service.db, 1);

    let transactions = 0;
    const counting: Db = { ...service.db, transaction: (run) => ((transactions += 1), service.db.transaction(run)) };

    const applying = service.apply(
      SET_ACCOUNT_PHASE,
      { parameters: { objectToModifyParameter: 'acc-1', phase: 'customer' }, options: EXECUTE_NONE },
      { db: counting },
    );

    await waitForLockWaits(service.db, 2);

    released.resolve(undefined);

    await blocker;

    await upgrading;

    expect(errorAnswer(await applying)).toEqual(OBJECT_CHANGED);

    expect(transactions).toBe(2);

    const [acc1] = await accounts();

    expect(acc1).toMatchObject({ account_id: 'acc-1', phase: 'prospect', location: {} });
  });
});
