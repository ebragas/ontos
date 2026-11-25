import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Edit } from '../edit.ts';
import { entriesSql, historyEntries } from './entries.ts';
import { checkValues } from './values.ts';
import { orThrow } from '../../errors/fallible.ts';
import { bindReader } from '../../db/index.ts';
import { type JsonValue } from '../../ontology/index.ts';
import type { SchemaMigration } from '../../publish/index.ts';
import { insertObjects, NS, startActions, type ActionsService, type RawAnswer } from '../actions.test-utils.ts';
import {
  compileOrThrow,
  datasetOf,
  propertyPoliciesIr,
  securityGroupsOf,
  stored,
  unchecked,
} from '../../ontology/stored.test-utils.ts';
import { sql } from '../../publish/publish.test-utils.ts';
import { groupGrants, policyPeople, PROPERTY_ROLES } from '../../policiesPeople.test-utils.ts';
import { UserId } from '../../auth/caller.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const ONTOLOGY = `/api/v2/ontologies/${'ri.ontology.main.ontology.22144f95-115e-4429-8bda-c69ce9a98a01'}`;

const PEOPLE = policyPeople(
  {
    ann: { sub: 'user_ann', role: 'member' },
    ben: { sub: 'user_ben', role: 'member' },
    admin: { sub: 'user_admin', role: 'admin' },
    guest: { sub: 'user_guest', role: 'guest' },
    auditor: { sub: 'user_aud', role: 'auditor' },
  },
  PROPERTY_ROLES,
);

type Person = keyof typeof PEOPLE;

const EVERYONE = Object.keys(PEOPLE) as Person[];

const FREE = ['accountId', 'ownerId', 'readers', 'tags'];
const PAY = ['name', 'phase', 'region', 'rate', 'profile'];
const OPS = ['notes', 'score', 'cost', 'startDate', 'seenAt', 'active'];

const ACCOUNTS: Readonly<Record<string, Readonly<Record<string, JsonValue>>>> = {
  'acc-1': {
    accountId: 'acc-1',
    name: 'Acme',
    phase: 'customer',
    region: 'west',
    rate: 10,
    profile: { label: 'gold', since: '2026-01-02' },
    ownerId: 'user_ann',
    readers: [],
    tags: ['t1'],
    notes: ['call'],
    score: 7,
    cost: '12.5',
    startDate: '2026-01-05',
    seenAt: '2026-02-01T10:00:00Z',
    active: true,
  },
  'acc-2': {
    accountId: 'acc-2',
    name: 'Globex',
    phase: 'prospect',
    region: 'east',
    rate: 20,
    profile: { label: 'silver' },
    ownerId: 'user_ben',
    readers: ['user_ann'],
    tags: [],
    notes: ['visit'],
    score: 3,
    cost: '8.25',
    startDate: '2026-03-01',
    seenAt: '2026-02-02T11:30:00Z',
    active: false,
  },
};

function historyIr(): OntologyIr {
  const ir = propertyPoliciesIr();

  for (const [apiName, storeAllPreviousProperties] of [
    [ACCOUNT, true],
    [ENGAGEMENT, false],
  ] as const) {
    const block = ir.ontology.objectTypes[apiName];

    if (!block) throw new Error(`The property policies IR has no ${apiName}.`);

    block.entityMetadata = unchecked({
      ...block.entityMetadata,
      editsHistory: { type: 'config', config: { store: apiName, storeAllPreviousProperties } },
    });
  }

  const name = ir.ontology.objectTypes[ACCOUNT]?.objectType.propertyTypes['name'];

  if (!name) throw new Error('The property policies IR has no name on Account.');

  delete name.dataConstraints;

  return ir;
}

const ontology = compileOrThrow(stored(historyIr()));

const { writer } = bindReader(
  { object: 'ontology_1_objects', engine: 'ontology_1_engine' },
  { userId: UserId.parse('user_admin'), permissions: PROPERTY_ROLES.admin, attributes: new Map() },
);

let service: ActionsService;

beforeAll(async () => {
  const ir = historyIr();

  service = await startActions(ir, undefined, groupGrants(ir, PROPERTY_ROLES));
});

afterAll(() => service?.stop());

beforeEach(() => service.clear());

async function write(
  edits: readonly Edit[],
  operationId: string,
  at: string,
  before: Readonly<Record<string, Readonly<Record<string, JsonValue>>>> = {},
): Promise<void> {
  const previous = (object: { primaryKey: string }) => new Map(Object.entries(before[object.primaryKey] ?? {}));

  const entries = historyEntries(
    orThrow(checkValues(edits, ontology, 'rules')),
    ontology,
    { operationId, actionTypeRid: 'ri.test', userId: 'user_admin' },
    previous,
  );

  await service.db.query(entriesSql(writer, entries));

  await service.db.query(
    sql(
      "UPDATE ontology_1_engine.edit_history SET created_at = $1::timestamptz WHERE entry ->> 'operationId' = $2",
      at,
      operationId,
    ),
  );
}

const account = (primaryKey: string) => ({ objectType: ACCOUNT, primaryKey });

const valuesOf = (values: Readonly<Record<string, JsonValue>>) =>
  new Map(Object.entries(values).filter(([name]) => name !== 'accountId'));

async function seed(without: readonly string[] = []): Promise<void> {
  const accounts = Object.fromEntries(
    Object.entries(ACCOUNTS).map(([key, values]) => [
      key,
      Object.fromEntries(Object.entries(values).filter(([name]) => !without.includes(name))),
    ]),
  );

  await insertObjects(service.db, ACCOUNT, Object.values(accounts));

  await write(
    [
      { type: 'addObject', object: account('acc-1'), properties: valuesOf(accounts['acc-1'] ?? {}) },
      { type: 'addObject', object: account('acc-2'), properties: valuesOf(accounts['acc-2'] ?? {}) },
    ],
    'op-1',
    '2026-05-01T00:00:00Z',
  );

  const phase = without.includes('phase') ? [] : ([['phase', 'closed']] as const);

  await write(
    [{ type: 'modifyObject', object: account('acc-1'), properties: new Map(phase) }],
    'op-2',
    '2026-05-02T00:00:00Z',
    accounts,
  );

  await service.db.query(
    sql("UPDATE ontology_1_objects.account SET phase = 'closed' WHERE account_id = 'acc-1' AND phase IS NOT NULL"),
  );

  await write([{ type: 'deleteObject', object: account('acc-2') }], 'op-3', '2026-05-03T00:00:00Z', accounts);

  await service.db.query(sql("DELETE FROM ontology_1_objects.account WHERE account_id = 'acc-2'"));
}

function historyOf(objectType: string, person: Person, body: object = {}): Promise<RawAnswer> {
  return service.call(
    'POST',
    `${ONTOLOGY}/objectTypes/${objectType}/editsHistory`,
    { sortOrder: 'oldest_first', ...body },
    PEOPLE[person],
  );
}

interface Entry {
  readonly objectPrimaryKey: Readonly<Record<string, { readonly value: string }>>;
  readonly userId: string;
  readonly edit: Readonly<Record<string, unknown>>;
}

async function keysOf(person: Person, body: object = {}): Promise<string[]> {
  const answer = await historyOf(ACCOUNT, person, body);

  expect(answer.status).toBe(200);

  return (JSON.parse(answer.text) as { data: Entry[] }).data.map(({ objectPrimaryKey, edit }) => {
    const keys = (field: string) =>
      Object.keys((edit[field] ?? {}) as object)
        .sort()
        .join(',');

    return `${objectPrimaryKey['accountId']?.value} ${String(edit['type'])} [${keys('properties')}] [${keys('previousProperties')}]`;
  });
}

const list = (...groups: string[][]) => groups.flat().sort().join(',');
const PRIMARY = ['accountId'];
const WITHOUT_KEY = FREE.filter((name) => name !== 'accountId');

function expected(acc1: string[][], acc2: string[][], includeAllPreviousProperties: boolean): string[] {
  const create = (groups: string[][]) => list(PRIMARY, WITHOUT_KEY, ...groups);
  const created = (groups: string[][]) => list(WITHOUT_KEY, ...groups);
  const modifyProperties = acc1.flat().includes('phase') ? 'phase' : '';
  const modifyPrevious = includeAllPreviousProperties ? create(acc1) : modifyProperties;

  return [
    `acc-1 createEdit [${created(acc1)}] []`,
    `acc-2 createEdit [${created(acc2)}] []`,
    `acc-1 modifyEdit [${modifyProperties}] [${modifyPrevious}]`,
    `acc-2 deleteEdit [] [${create(acc2)}]`,
  ];
}

const SEES: Readonly<Record<Person, readonly [string[][], string[][]]>> = {
  ann: [[PAY], [PAY]],
  ben: [[], [PAY]],
  admin: [
    [PAY, OPS],
    [PAY, OPS],
  ],
  guest: [[], []],
  auditor: [[OPS], [OPS]],
};

describe('ontology/object-edits/edit-history#security: a published property security policy cuts each hidden value from each entry', () => {
  it.each([false, true])(
    'ontology/object-edits/edit-history#security: each person reads each entry, with the values of each policy that fails on the Object as it is now cut (includeAllPreviousProperties: %s)',
    async (includeAllPreviousProperties) => {
      await seed();

      for (const person of EVERYONE) {
        const [acc1, acc2] = SEES[person];

        expect({ person, entries: await keysOf(person, { includeAllPreviousProperties }) }).toEqual({
          person,
          entries: expected(acc1, acc2, includeAllPreviousProperties),
        });
      }
    },
  );

  it('ontology/object-edits/edit-history#security: the values that show are the stored values, and userId stays', async () => {
    await seed();

    const answer = JSON.parse((await historyOf(ACCOUNT, 'ann', { includeAllPreviousProperties: true })).text) as {
      data: Entry[];
    };

    const [, , modify, deleted] = answer.data;

    expect(modify?.edit).toEqual({
      type: 'modifyEdit',
      properties: { phase: 'closed' },
      previousProperties: {
        accountId: 'acc-1',
        name: 'Acme',
        phase: 'customer',
        region: 'west',
        rate: 10,
        profile: { label: 'gold', since: '2026-01-02' },
        ownerId: 'user_ann',
        readers: [],
        tags: ['t1'],
      },
      includesAllPreviousValues: true,
    });

    expect(deleted?.edit).toEqual({
      type: 'deleteEdit',
      previousProperties: {
        accountId: 'acc-2',
        name: 'Globex',
        phase: 'prospect',
        region: 'east',
        rate: 20,
        profile: { label: 'silver' },
        ownerId: 'user_ben',
        readers: ['user_ann'],
        tags: [],
      },
    });

    expect(answer.data.map((entry) => entry.userId)).toEqual(['user_admin', 'user_admin', 'user_admin', 'user_admin']);
  });

  it.each([
    ['guest', [...PAY, ...OPS]],
    ['ann', OPS],
    ['auditor', PAY],
  ] as const)(
    'ontology/object-edits/edit-history#security: %s gets the same bytes when the values hidden from them are present and when they have no value',
    async (person, hidden) => {
      await seed();

      const present = [
        (await historyOf(ACCOUNT, person, { includeAllPreviousProperties: true })).text,
        (await historyOf(ACCOUNT, person)).text,
      ];

      await service.clear();

      await seed(hidden);

      expect([
        (await historyOf(ACCOUNT, person, { includeAllPreviousProperties: true })).text,
        (await historyOf(ACCOUNT, person)).text,
      ]).toEqual(present);
    },
  );

  it('ontology/object-edits/edit-history#security: admin gets other bytes when the values have no value, so the same bytes above are a cut', async () => {
    await seed();

    const present = (await historyOf(ACCOUNT, 'admin', { includeAllPreviousProperties: true })).text;

    await service.clear();

    await seed([...PAY, ...OPS]);

    expect((await historyOf(ACCOUNT, 'admin', { includeAllPreviousProperties: true })).text).not.toBe(present);
  });

  it('ontology/object-edits/edit-history#security: get_edit_history gives each person the page of the route', async () => {
    await seed();

    for (const person of EVERYONE) {
      const tool = await service.tool(
        'get_edit_history',
        { objectType: ACCOUNT, sortOrder: 'oldest_first', includeAllPreviousProperties: true },
        PEOPLE[person],
      );

      const route = JSON.parse(
        (await historyOf(ACCOUNT, person, { includeAllPreviousProperties: true })).text,
      ) as unknown;

      expect({
        person,
        page: (tool.body as { result: { structuredContent: unknown } }).result.structuredContent,
      }).toEqual({ person, page: route });
    }
  });
});

describe('ontology/object-edits/edit-history#security: a foreign key Property follows its own policy', () => {
  it('ontology/object-edits/edit-history#security: a member reads the Engagement entries with accountId and amount cut, admin reads them, and the route does not check the linked Account', async () => {
    await insertObjects(service.db, ENGAGEMENT, [
      { engagementId: 'eng-1', accountId: 'acc-1', title: 'First', amount: 100, status: 'open' },
      { engagementId: 'eng-2', accountId: 'acc-none', title: 'Second', amount: 200, status: 'open' },
    ]);

    const engagement = (primaryKey: string, accountId: string, title: string, amount: number) =>
      ({
        type: 'addObject',
        object: { objectType: ENGAGEMENT, primaryKey },
        properties: new Map<string, JsonValue>([
          ['accountId', accountId],
          ['title', title],
          ['amount', amount],
          ['status', 'open'],
        ]),
      }) as const;

    await write(
      [engagement('eng-1', 'acc-1', 'First', 100), engagement('eng-2', 'acc-none', 'Second', 200)],
      'op-1',
      '2026-05-01T00:00:00Z',
    );

    const properties = async (person: Person) => {
      const answer = await historyOf(ENGAGEMENT, person);

      expect(answer.status).toBe(200);

      return (JSON.parse(answer.text) as { data: Entry[] }).data.map((entry) => entry.edit['properties']);
    };

    expect(await properties('ann')).toEqual([
      { title: 'First', status: 'open' },
      { title: 'Second', status: 'open' },
    ]);

    expect(await properties('admin')).toEqual([
      { accountId: 'acc-1', title: 'First', amount: 100, status: 'open' },
      { accountId: 'acc-none', title: 'Second', amount: 200, status: 'open' },
    ]);

    expect(await properties('guest')).toEqual([]);
  });
});

function accountOf(ir: OntologyIr) {
  const block = ir.ontology.objectTypes[ACCOUNT];

  if (!block) throw new Error('The property policies IR has no Account.');

  return block;
}

function deprecated(names: readonly string[]): OntologyIr {
  const ir = historyIr();

  for (const name of names) {
    const property = accountOf(ir).objectType.propertyTypes[name];

    if (!property) throw new Error(`The property policies IR has no ${name} on Account.`);

    property.status = unchecked({
      type: 'deprecated',
      deprecated: { message: 'Gone soon.', deadline: '2027-01-01T00:00:00Z' },
    });
  }

  return ir;
}

function withoutRate(ir: OntologyIr): OntologyIr {
  const block = accountOf(ir);

  delete block.objectType.propertyTypes['rate'];

  delete datasetOf(block).propertyMapping['rate'];

  for (const group of securityGroupsOf(block)) group.properties = group.properties.filter((name) => name !== 'rate');

  expect(JSON.stringify(ir)).not.toContain('"rate"');

  return ir;
}

describe('editsHistory primary-key reuse lifecycle isolation', () => {
  it('hides a deleted instance history when another caller recreates the same primary key, both while live and after deleting again', async () => {
    const annSecret: Readonly<Record<string, JsonValue>> = {
      ...(ACCOUNTS['acc-1'] ?? {}),
      accountId: 'acc-reuse',
      ownerId: 'user_ann',
      readers: [],
      name: 'Ann Classified',
    };

    const benOwned: Readonly<Record<string, JsonValue>> = {
      ...(ACCOUNTS['acc-2'] ?? {}),
      accountId: 'acc-reuse',
      ownerId: 'user_ben',
      readers: [],
      name: 'Ben Recreated',
    };

    await write(
      [{ type: 'addObject', object: account('acc-reuse'), properties: valuesOf(annSecret) }],
      'op-reuse-1',
      '2026-05-01T00:00:00Z',
    );

    await write([{ type: 'deleteObject', object: account('acc-reuse') }], 'op-reuse-2', '2026-05-02T00:00:00Z', {
      'acc-reuse': annSecret,
    });

    await insertObjects(service.db, ACCOUNT, [benOwned]);

    await write(
      [{ type: 'addObject', object: account('acc-reuse'), properties: valuesOf(benOwned) }],
      'op-reuse-3',
      '2026-05-03T00:00:00Z',
    );

    const liveHistory = await historyOf(ACCOUNT, 'ben', {
      primaryKey: { accountId: 'acc-reuse' },
      includeAllPreviousProperties: true,
    });

    expect(liveHistory.status).toBe(200);

    const liveEntries = (JSON.parse(liveHistory.text) as { data: Entry[] }).data;

    expect(liveEntries.map((entry) => entry.edit['type'])).toEqual(['createEdit']);
    expect(liveHistory.text).not.toContain('Ann Classified');

    await write([{ type: 'deleteObject', object: account('acc-reuse') }], 'op-reuse-4', '2026-05-04T00:00:00Z', {
      'acc-reuse': benOwned,
    });

    await service.db.query(sql("DELETE FROM ontology_1_objects.account WHERE account_id = 'acc-reuse'"));

    const deletedHistory = await historyOf(ACCOUNT, 'ben', {
      primaryKey: { accountId: 'acc-reuse' },
      includeAllPreviousProperties: true,
    });

    expect(deletedHistory.status).toBe(200);

    const deletedEntries = (JSON.parse(deletedHistory.text) as { data: Entry[] }).data;

    expect(deletedEntries.map((entry) => entry.edit['type'])).toEqual(['createEdit', 'deleteEdit']);
    expect(deletedHistory.text).not.toContain('Ann Classified');
  });
});

describe('ontology/object-edits/edit-history#security: a key of a Property that a publish moved or dropped is cut from each entry', () => {
  it('ontology/object-edits/edit-history#security: after a Move of region to area, and then a Drop of rate, no person reads region or rate in an entry', async () => {
    await seed();

    const publish = (ir: OntologyIr, migrations: readonly SchemaMigration[] = []) =>
      service.publish(ir, undefined, groupGrants(ir, PROPERTY_ROLES), migrations);

    const pageOf = async (gone: readonly string[]) => {
      const pay = PAY.filter((name) => !gone.includes(name));
      const sees = (groups: string[][]) => groups.map((group) => (group === PAY ? pay : group));

      for (const person of EVERYONE) {
        const [acc1, acc2] = SEES[person];

        expect
          .soft({ person, gone, entries: await keysOf(person, { includeAllPreviousProperties: true }) })
          .toEqual({ person, gone, entries: expected(sees(acc1), sees(acc2), true) });
      }
    };

    await publish(deprecated(['region', 'rate']));

    const moved = JSON.parse(JSON.stringify(deprecated(['rate'])).replaceAll('"region"', '"area"')) as OntologyIr;

    await publish(moved, [{ type: 'renameProperty', objectType: ACCOUNT, source: 'region', target: 'area' }]);

    await pageOf(['region']);

    await publish(withoutRate(moved), [{ type: 'dropProperty', objectType: ACCOUNT, property: 'rate' }]);

    await pageOf(['region', 'rate']);
  });
});
