import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertObjects, startActions, type ActionsService, type RawAnswer } from '../actions/actions.test-utils.ts';
import { groupGrants } from '../policiesPeople.test-utils.ts';
import {
  ACCOUNT,
  addString,
  at,
  CATEGORY,
  derivedIr,
  type Json,
  ONTOLOGY,
  PEOPLE,
  ROLE_ASSIGNMENT,
  ROLES,
  TRANSACTION,
} from './derived.test-utils.ts';

const SIZE = 'ontology/ontology-sdk/object-sets#request-size';
const STORED = 850;

function wideIr(): OntologyIr {
  const ir: Json = JSON.parse(JSON.stringify(derivedIr()));
  const block = at(ir, 'ontology', 'objectTypes', TRANSACTION);

  for (let i = 1; i <= STORED; i += 1) addString(block, `s${i}`);

  return JSON.parse(JSON.stringify(ir)) as OntologyIr;
}

const IR = wideIr();
const GRANTS = groupGrants(IR, ROLES);
let service: ActionsService;

beforeAll(async () => {
  service = await startActions(IR, undefined, {
    ...GRANTS,
    objectTypes: { ...GRANTS.objectTypes, [CATEGORY]: 'admin', [ROLE_ASSIGNMENT]: 'admin' },
  });

  await insertObjects(service.db, ACCOUNT, [{ accountId: 'acc-1', name: 'Acme', entity: 'E1' }]);

  await insertObjects(service.db, TRANSACTION, [
    {
      transactionId: 'tx-1',
      accountId: 'acc-1',
      categoryId: 'cat-1',
      amount: '1.00',
      units: 2,
      owner: 'user_two',
      amountViewer: 'user_two',
    },
    {
      transactionId: 'tx-2',
      accountId: 'acc-1',
      categoryId: 'cat-1',
      amount: '2.00',
      units: 3,
      owner: 'user_two',
      amountViewer: 'user_two',
    },
  ]);
}, 600_000);

afterAll(() => service?.stop());

const units = { type: 'property', apiName: 'units' };
const names = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);
const ascending = (fields: readonly string[]) => ({ fields: fields.map((field) => ({ field, direction: 'asc' })) });
const base = { type: 'base', objectType: TRANSACTION };

const definitions = (count: number) => ({
  type: 'withProperties',
  objectSet: base,
  derivedProperties: Object.fromEntries(
    names('d', count).map((name) => [name, { type: 'add', properties: [units, units] }]),
  ),
});

const post = (route: 'loadObjects' | 'aggregate', body: unknown): Promise<RawAnswer> =>
  service.call('POST', `${ONTOLOGY}/objectSets/${route}`, body, PEOPLE.one);

function expectTooWide(answer: RawAnswer): void {
  expect(answer.status).toBe(400);
  expect(answer.contentType).toBe('application/json');

  const { errorInstanceId, ...body } = JSON.parse(answer.text) as Json;

  expect(errorInstanceId).toEqual(expect.any(String));

  expect(body).toEqual({
    errorCode: 'INVALID_ARGUMENT',
    errorName: 'Default:InvalidArgument',
    parameters: { maximumColumns: 1664 },
  });
}

describe(`${SIZE}: a read has at most 1,664 columns of SQL`, () => {
  it(`${SIZE}: a plain read with 829 orderBy fields on stored Properties gives its page`, async () => {
    const answer = await post('loadObjects', {
      excludeRid: true,
      objectSet: base,
      select: ['transactionId'],
      orderBy: ascending(names('s', 829)),
    });

    expect(answer.status).toBe(200);
    expect((JSON.parse(answer.text) as { data: unknown[] }).data).toHaveLength(2);
  });

  it(`${SIZE}: a plain read with 830 orderBy fields on stored Properties gets a whole 400 body, not a cut page`, async () => {
    expectTooWide(
      await post('loadObjects', {
        excludeRid: true,
        objectSet: base,
        select: ['transactionId'],
        orderBy: ascending(names('s', 830)),
      }),
    );
  });

  it(`${SIZE}: 1,000 withProperties definitions with 850 orderBy fields on them get the 400`, async () => {
    expectTooWide(
      await post('loadObjects', {
        excludeRid: true,
        objectSet: definitions(1000),
        select: ['transactionId'],
        orderBy: ascending(names('d', 850)),
      }),
    );
  });

  it(`${SIZE}: 1,000 withProperties definitions with an empty select on an Object Type with 861 stored Properties get the 400`, async () => {
    expectTooWide(await post('loadObjects', { excludeRid: true, objectSet: definitions(1000), select: [] }));
  });

  it(`${SIZE}: an aggregate with 1,700 metrics gets the 400`, async () => {
    const aggregation = names('c', 1700).map((name) => ({ type: 'count', name }));

    expectTooWide(await post('aggregate', { objectSet: base, aggregation, groupBy: [] }));
  });
});
