import type { OntologyIr, OntologyIrObjectTypeBlockDataV2, OntologyIrType } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { quoteName } from '../db/index.ts';
import { columnName, tableName } from '../ontology/index.ts';
import type { SchemaMigration } from '../publish/index.ts';
import { insertObjects, NS, startActions, type ActionsService, type Answer } from '../actions/actions.test-utils.ts';
import { workosUsers } from '../auth/index.ts';
import { datasetOf, propertyPoliciesIr, securityGroupsOf } from '../ontology/stored.test-utils.ts';
import { groupGrants, policyPeople, PROPERTY_ROLES, type AsPerson } from '../policiesPeople.test-utils.ts';
import { ORGANIZATION } from '../tokens.test-utils.ts';
import { STUB_PERSON, STUB_WORKOS_KEY, stubWorkos, type StubWorkos } from '../workos.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import { errorAnswer, pageOf } from './objectSets.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ROLES = PROPERTY_ROLES;

const PEOPLE = policyPeople(
  {
    ann: { sub: 'user_ann', role: 'member' },
    admin: { sub: 'user_admin', role: 'admin' },
  },
  ROLES,
);

type Person = keyof typeof PEOPLE | AsPerson;

function carlStub(permissions: readonly string[]): StubWorkos {
  const carl = { ...STUB_PERSON, id: 'user_carl', email: 'carl@example.com' };

  return stubWorkos(
    [carl],
    [
      {
        user_id: carl.id,
        organization_id: ORGANIZATION,
        status: 'active',
        organization_name: 'Test Organization',
        roles: ['org-carl'],
      },
    ],
    {
      roles: { [ORGANIZATION]: { 'org-carl': permissions } },
    },
  );
}

function carlOf(stub: StubWorkos): AsPerson {
  return { claims: { sub: 'user_carl' }, users: workosUsers(STUB_WORKOS_KEY, { fetch: stub.fetch }) };
}

let service: ActionsService;
let current: OntologyIr;

beforeAll(async () => {
  current = propertyPoliciesIr();

  service = await startActions(current, undefined, groupGrants(current, ROLES));
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  await insertObjects(service.db, ACCOUNT, [
    { accountId: 'acc-1', name: 'Acme', rate: 10, ownerId: 'user_ann', readers: [] },
    { accountId: 'acc-2', name: 'Globex', rate: 20, ownerId: 'user_ben', readers: ['user_ann'] },
    { accountId: 'acc-3', name: 'Initech', rate: 30, ownerId: 'user_carl', readers: [] },
    { accountId: 'acc-4', name: 'Hooli', rate: 40, ownerId: null, readers: [] },
    { accountId: 'acc-5', name: 'Stark', rate: 50, ownerId: '', readers: [] },
  ]);
});

async function writeEach(property: string, value: (n: number) => unknown): Promise<void> {
  for (let n = 1; n <= 5; n += 1) {
    await service.db.query(
      sql(
        `UPDATE ontology_1_objects.${quoteName(tableName(ACCOUNT))} SET ${quoteName(columnName(property))} = $1 WHERE ${quoteName(columnName('accountId'))} = $2`,
        value(n),
        `acc-${n}`,
      ),
    );
  }
}

const byRate = {
  objectSet: { type: 'base', objectType: ACCOUNT },
  select: [],
  pageSize: 2,
  orderBy: { fields: [{ field: 'rate', direction: 'asc' }] },
};

function load(body: object, person: Person, pageToken?: string): Promise<Answer> {
  return service.loadObjects(
    pageToken === undefined ? body : { ...body, pageToken },
    typeof person === 'string' ? PEOPLE[person] : person,
  );
}

function keysOf(answer: Answer): { keys: unknown; token: string | undefined } {
  const page = pageOf(answer);

  if (page.status !== 200) throw new Error(`The page gave ${answer.status}: ${JSON.stringify(answer.body)}`);

  const token = (answer.body as { nextPageToken?: string }).nextPageToken;

  return { keys: page.primaryKeys, token };
}

async function restOfRead(body: object, person: Person, token: string | undefined): Promise<unknown[]> {
  const pages: unknown[] = [];

  while (token !== undefined) {
    if (pages.length === 10) throw new Error('The read did not end after 10 pages.');

    const page = keysOf(await load(body, person, token));

    pages.push(page.keys);

    token = page.token;
  }

  return pages;
}

type AccountBlock = OntologyIrObjectTypeBlockDataV2;

function propertyOf(account: AccountBlock, property: string) {
  const type = account.objectType.propertyTypes[property];

  if (!type) throw new Error(`The Account has no Property ${property}.`);

  return type;
}

const experimental = (property: string) => (account: AccountBlock) => {
  propertyOf(account, property).status = { type: 'experimental', experimental: {} };
};

const without = <T>(record: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

const removed = (property: string) => (account: AccountBlock) => {
  account.objectType.propertyTypes = without(account.objectType.propertyTypes, property);

  const dataset = datasetOf(account);

  dataset.propertyMapping = without(dataset.propertyMapping, property);

  for (const group of securityGroupsOf(account))
    group.properties = group.properties.filter((name) => name !== property);
};

const retyped = (property: string, type: OntologyIrType) => (account: AccountBlock) => {
  propertyOf(account, property).type = type;
};

const inPlainGroup = (property: string) => (account: AccountBlock) => {
  for (const group of securityGroupsOf(account)) {
    group.properties = group.properties.filter((name) => name !== property);

    if (group.rid === 'plain') group.properties.push(property);
  }
};

async function publish(
  change: (account: AccountBlock) => void,
  migrations: readonly SchemaMigration[] = [],
): Promise<void> {
  const ir = structuredClone(current);
  const account = ir.ontology.objectTypes[ACCOUNT];

  if (!account) throw new Error('The IR has no Account.');

  change(account);

  await service.publish(ir, undefined, groupGrants(ir, ROLES), migrations);

  current = ir;
}

async function publishAsExperimentalThen(
  property: string,
  change: (account: AccountBlock) => void,
  migrations: readonly SchemaMigration[] = [],
): Promise<void> {
  await publish(experimental(property));

  await publish(change, migrations);
}

describe('a change between 2 pages that may make the next page skip or repeat an Object', () => {
  it('an edit that moves the rate of acc-3 before the page token makes page 2 skip acc-3, with no error', async () => {
    const first = keysOf(await load(byRate, 'admin'));

    expect(first.keys).toEqual(['acc-1', 'acc-2']);

    await service.db.query(sql("UPDATE ontology_1_objects.account SET rate = 5 WHERE account_id = 'acc-3'"));

    expect(await restOfRead(byRate, 'admin', first.token)).toEqual([['acc-4', 'acc-5']]);
  });

  it('an edit that moves the rate of acc-1 after the page token makes page 2 repeat acc-1, with no error', async () => {
    const first = keysOf(await load(byRate, 'admin'));

    expect(first.keys).toEqual(['acc-1', 'acc-2']);

    await service.db.query(sql("UPDATE ontology_1_objects.account SET rate = 35 WHERE account_id = 'acc-1'"));

    expect(await restOfRead(byRate, 'admin', first.token)).toEqual([
      ['acc-3', 'acc-1'],
      ['acc-4', 'acc-5'],
    ]);
  });

  it('ontology/ontology-sdk/object-sets#paging: a change of the permissions of the role of carl from those of admin to those of member hides the rate of acc-4 and acc-5, so page 2 skips them, with no error', async () => {
    const stub = carlStub(ROLES.admin);

    const first = keysOf(await load(byRate, carlOf(stub)));

    expect(first.keys).toEqual(['acc-1', 'acc-2']);

    stub.setRole(ORGANIZATION, 'org-carl', ROLES.member);

    expect(await restOfRead(byRate, carlOf(stub), first.token)).toEqual([['acc-3']]);
  });

  it('ontology/ontology-sdk/object-sets#paging: a change of the permissions of the role of carl from those of member to those of admin shows each rate, so page 2 repeats acc-1 and acc-2, with no error', async () => {
    const stub = carlStub(ROLES.member);

    const first = keysOf(await load(byRate, carlOf(stub)));

    expect(first.keys).toEqual(['acc-1', 'acc-2']);

    stub.setRole(ORGANIZATION, 'org-carl', ROLES.admin);

    expect(await restOfRead(byRate, carlOf(stub), first.token)).toEqual([
      ['acc-1', 'acc-2'],
      ['acc-3', 'acc-4'],
      ['acc-5'],
    ]);
  });

  it('a publish that moves phase out of the policy pay shows each phase to ann, so the next pages repeat acc-3 and acc-4, with no error', async () => {
    const byPhase = { ...byRate, orderBy: { fields: [{ field: 'phase', direction: 'asc' }] } };

    await writeEach('phase', (n) => `phase-${n}`);

    const first = keysOf(await load(byPhase, 'ann'));

    expect(first.keys).toEqual(['acc-3', 'acc-4']);

    await publish(inPlainGroup('phase'));

    expect(await restOfRead(byPhase, 'ann', first.token)).toEqual([['acc-1', 'acc-2'], ['acc-3', 'acc-4'], ['acc-5']]);
  });
});

describe('a page token after a publish that removes a Property that the body names', () => {
  it('ontology/ontology-sdk/object-sets#paging: region in the select, the orderBy, or the where gets 404 PropertiesNotFound, with the token and with no token', async () => {
    const byKey = { ...byRate, orderBy: { fields: [{ field: 'accountId', direction: 'asc' }] } };

    const bodies = {
      select: { ...byKey, select: ['accountId', 'region'] },
      orderBy: {
        ...byKey,
        orderBy: {
          fields: [
            { field: 'region', direction: 'asc' },
            { field: 'accountId', direction: 'asc' },
          ],
        },
      },
      where: {
        ...byKey,
        objectSet: {
          type: 'filter',
          objectSet: byKey.objectSet,
          where: { type: 'not', value: { type: 'eq', field: 'region', value: 'north' } },
        },
      },
    };

    const tokens: Record<string, string | undefined> = {};

    for (const [field, body] of Object.entries(bodies)) {
      const first = keysOf(await load(body, 'admin'));

      expect(first.keys).toEqual(['acc-1', 'acc-2']);

      tokens[field] = first.token;
    }

    await publishAsExperimentalThen('region', removed('region'));

    const notFound = {
      status: 404,
      body: {
        errorCode: 'NOT_FOUND',
        errorName: 'PropertiesNotFound',
        parameters: { objectType: ACCOUNT, properties: ['region'] },
      },
    };

    for (const [field, body] of Object.entries(bodies)) {
      expect({ field, withToken: errorAnswer(await load(body, 'admin', tokens[field])) }).toEqual({
        field,
        withToken: notFound,
      });

      expect({ field, noToken: errorAnswer(await load(body, 'admin')) }).toEqual({ field, noToken: notFound });
    }
  });
});

describe('a page token from before a publish that changes the base type of a sort Property', () => {
  const bySeenAt = { ...byRate, orderBy: { fields: [{ field: 'seenAt', direction: 'asc' }] } };
  const byScore = { ...byRate, orderBy: { fields: [{ field: 'score', direction: 'asc' }] } };

  it('ontology/ontology-sdk/object-sets#paging: after seenAt becomes an Integer, the Timestamp in the token of admin gets 400 InvalidPageToken, and the hidden seenAt in the token of ann passes', async () => {
    await writeEach('seenAt', (n) => `2026-02-0${n}T10:00:00Z`);

    const admin = keysOf(await load(bySeenAt, 'admin'));

    const ann = keysOf(await load(bySeenAt, 'ann'));

    expect([admin.keys, ann.keys]).toEqual([
      ['acc-1', 'acc-2'],
      ['acc-1', 'acc-2'],
    ]);

    await publishAsExperimentalThen('seenAt', retyped('seenAt', { type: 'integer', integer: {} }), [
      { type: 'dropProperty', objectType: ACCOUNT, property: 'seenAt' },
    ]);

    expect(errorAnswer(await load(bySeenAt, 'admin', admin.token))).toEqual({
      status: 400,
      body: { errorCode: 'INVALID_ARGUMENT', errorName: 'InvalidPageToken', parameters: { pageToken: admin.token } },
    });

    expect(await restOfRead(bySeenAt, 'ann', ann.token)).toEqual([['acc-3', 'acc-4'], ['acc-5']]);
  });

  it('ontology/ontology-sdk/object-sets#paging: after score becomes a Double, the Integer 2 in the token of admin passes, and the read goes on after the score 2', async () => {
    await writeEach('score', (n) => n);

    const first = keysOf(await load(byScore, 'admin'));

    expect(first.keys).toEqual(['acc-1', 'acc-2']);

    await publishAsExperimentalThen('score', retyped('score', { type: 'double', double: {} }), [
      { type: 'dropProperty', objectType: ACCOUNT, property: 'score' },
    ]);

    await writeEach('score', (n) => n + 0.5);

    expect(await restOfRead(byScore, 'admin', first.token)).toEqual([
      ['acc-2', 'acc-3'],
      ['acc-4', 'acc-5'],
    ]);
  });
});
