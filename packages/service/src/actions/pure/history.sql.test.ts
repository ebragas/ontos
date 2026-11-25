import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bindReader } from '../../db/index.ts';
import { orThrow } from '../../errors/fallible.ts';
import { historyEntry, historySql, readHistoryRequest, type HistoryRow } from './history.ts';
import { entriesSql, historyEntries } from './entries.ts';
import { checkValues } from './values.ts';
import type { Edit } from '../edit.ts';
import { type CompiledObjectType, type CompiledOntology, type JsonValue, type Policy } from '../../ontology/index.ts';
import {
  insertObjects,
  NS,
  startActions,
  twinFunctions,
  type ActionsService,
  type RawAnswer,
} from '../actions.test-utils.ts';
import { compileOrThrow, policiesIr, stored, unchecked, USE } from '../../ontology/stored.test-utils.ts';
import { sql } from '../../publish/publish.test-utils.ts';
import { groupGrants, policyPeople } from '../../policiesPeople.test-utils.ts';
import { UserId } from '../../auth/caller.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const ONTOLOGY = `/api/v2/ontologies/${'ri.ontology.main.ontology.22144f95-115e-4429-8bda-c69ce9a98a01'}`;
const EXECUTE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };

const QUOTED_CHARACTERS = 'user_"q,{x}\\ é\'😀';

const ROLES = { admin: ['ontology:install', USE, 'admin'], member: [USE, 'member'], guest: [USE] };

const PEOPLE = policyPeople(
  {
    ann: { sub: 'user_ann', role: 'member' },
    ben: { sub: 'user_ben', role: 'member' },
    admin: { sub: 'user_admin', role: 'admin' },
    nobody: { sub: 'user_nobody', role: 'guest' },
  },
  ROLES,
);

type Person = keyof typeof PEOPLE;

const EVERYONE = Object.keys(PEOPLE) as Person[];

const ODD_PEOPLE = { odd: QUOTED_CHARACTERS, null: 'NULL' } as const;
const SCHEMAS = { object: 'ontology_1_objects', engine: 'ontology_1_engine' };

let service: ActionsService;

function historyIr() {
  const ir = policiesIr();
  const account = ir.ontology.objectTypes[ACCOUNT];

  if (!account) throw new Error('The policies IR has no Account.');

  account.entityMetadata = unchecked({
    ...account.entityMetadata,
    editsHistory: { type: 'config', config: { store: ACCOUNT, storeAllPreviousProperties: true } },
  });

  const engagement = ir.ontology.objectTypes[ENGAGEMENT];

  if (!engagement) throw new Error('The policies IR has no Engagement.');

  engagement.entityMetadata = unchecked({
    ...engagement.entityMetadata,
    editsHistory: { type: 'config', config: { store: ENGAGEMENT, storeAllPreviousProperties: false } },
  });

  return ir;
}

beforeAll(async () => {
  const ir = historyIr();

  service = await startActions(ir, twinFunctions('0.6.3'), groupGrants(ir, ROLES));
});

afterAll(() => service?.stop());

beforeEach(() => service.clear());

function post(path: string, body: unknown, person: Person): Promise<RawAnswer> {
  return service.call('POST', `${ONTOLOGY}/${path}`, body, PEOPLE[person]);
}

async function apply(actionType: string, parameters: object): Promise<void> {
  const answer = await service.apply(`${NS}${actionType}`, { parameters, options: EXECUTE }, PEOPLE.admin);

  expect(answer.status).toBe(200);
}

const create = (accountId: string, ownerId: string, viewers: string[] = ['reviewer']) =>
  apply('create-account', { accountId, name: accountId, phase: 'customer', ownerId, viewers });

const reassign = (accountId: string, ownerId: string, viewers: string[] = ['reviewer']) =>
  apply('set-account-phase', { objectToModifyParameter: accountId, phase: 'prospect', ownerId, viewers });

const remove = (accountId: string) => apply('delete-account', { objectToDeleteParameter: accountId });

function historyOf(person: Person, body: object = {}): Promise<RawAnswer> {
  return post(`objectTypes/${ACCOUNT}/editsHistory`, { sortOrder: 'oldest_first', ...body }, person);
}

async function entriesOf(person: Person, body: object = {}): Promise<string[]> {
  const answer = await historyOf(person, body);

  expect(answer.status).toBe(200);

  const page = JSON.parse(answer.text) as {
    data: { objectPrimaryKey: { accountId: { value: string } }; edit: { type: string } }[];
  };

  return page.data.map((entry) => `${entry.objectPrimaryKey.accountId.value} ${entry.edit.type}`);
}

async function each<T>(
  read: (person: Person) => Promise<T>,
  people: readonly Person[] = ['ann', 'ben', 'admin', 'nobody'],
): Promise<Partial<Record<Person, T>>> {
  const answers: Partial<Record<Person, T>> = {};

  for (const person of people) answers[person] = await read(person);

  return answers;
}

const byKey = (accountId: string) => ({ objectPrimaryKey: { accountId: { type: 'stringValue', value: accountId } } });
const EMPTY = '{"data":[],"totalCount":0}';

describe('ontology/object-edits/edit-history#security: the Object as it is now decides which entries a person sees', () => {
  it('ontology/object-edits/edit-history#security ontology/object-edits/edit-history#reading: a reassignment moves the whole history of the Object to the new assignee', async () => {
    await create('acc-1', 'user_ann');

    await reassign('acc-1', 'user_ann');

    expect(await each((person) => entriesOf(person))).toEqual({
      ann: ['acc-1 createEdit', 'acc-1 modifyEdit'],
      ben: [],
      admin: ['acc-1 createEdit', 'acc-1 modifyEdit'],
      nobody: [],
    });

    await reassign('acc-1', 'user_ben');

    expect(await each((person) => entriesOf(person, byKey('acc-1')))).toEqual({
      ann: [],
      ben: ['acc-1 createEdit', 'acc-1 modifyEdit', 'acc-1 modifyEdit'],
      admin: ['acc-1 createEdit', 'acc-1 modifyEdit', 'acc-1 modifyEdit'],
      nobody: [],
    });
  });

  it('ontology/object-edits/edit-history#security: a permission in viewers shows the entries, and a person who lacks it sees none', async () => {
    await create('acc-1', 'user_carl', ['member']);

    expect(await each((person) => entriesOf(person))).toEqual({
      ann: ['acc-1 createEdit'],
      ben: ['acc-1 createEdit'],
      admin: ['acc-1 createEdit'],
      nobody: [],
    });
  });

  it('ontology/object-edits/edit-history#security: with no objectPrimaryKey, the route returns only the entries of the Objects that the person can view now', async () => {
    await create('acc-1', 'user_ann');

    await create('acc-2', 'user_ben');

    await create('acc-3', 'user_ann', ['user_ben']);

    await reassign('acc-2', 'user_ben');

    expect(await each((person) => entriesOf(person))).toEqual({
      ann: ['acc-1 createEdit', 'acc-3 createEdit'],
      ben: ['acc-2 createEdit', 'acc-3 createEdit', 'acc-2 modifyEdit'],
      admin: ['acc-1 createEdit', 'acc-2 createEdit', 'acc-3 createEdit', 'acc-2 modifyEdit'],
      nobody: [],
    });
  });

  it('ontology/object-edits/edit-history#security: the key of a hidden Object gives the bytes of a key with no history', async () => {
    await create('acc-1', 'user_ann');

    await remove('acc-1');

    await create('acc-2', 'user_ann');

    for (const key of ['acc-1', 'acc-2']) {
      expect((await historyOf('ben', byKey(key))).text).toBe(EMPTY);

      expect((await historyOf('nobody', byKey(key))).text).toBe(EMPTY);
    }

    expect((await historyOf('ben', byKey('acc-none'))).text).toBe(EMPTY);

    expect(await entriesOf('ann', byKey('acc-1'))).toEqual(['acc-1 createEdit', 'acc-1 deleteEdit']);
  });
});

describe('ontology/object-edits/edit-history#security: for a deleted Object, now is its latest delete entry', () => {
  it('ontology/object-edits/edit-history#security: the delete entry decides, and a create again gives the decision to the new row', async () => {
    await create('acc-1', 'user_ann');

    await remove('acc-1');

    expect(await each((person) => entriesOf(person))).toEqual({
      ann: ['acc-1 createEdit', 'acc-1 deleteEdit'],
      ben: [],
      admin: ['acc-1 createEdit', 'acc-1 deleteEdit'],
      nobody: [],
    });

    await create('acc-1', 'user_ben');

    const recreated = ['acc-1 createEdit'];

    expect(await each((person) => entriesOf(person))).toEqual({
      ann: [],
      ben: recreated,
      admin: recreated,
      nobody: [],
    });

    await remove('acc-1');

    await create('acc-1', 'user_ann', ['user_ben']);

    await remove('acc-1');

    const latest = ['acc-1 createEdit', 'acc-1 deleteEdit'];

    expect(await each((person) => entriesOf(person))).toEqual({ ann: latest, ben: latest, admin: latest, nobody: [] });
  });

  it('ontology/object-edits/edit-history#security: an Object with no current row and no delete entry shows no entry, to admin too', async () => {
    await create('acc-1', 'user_ann');

    await create('acc-2', 'user_ann');

    await service.db.query(sql("DELETE FROM ontology_1_objects.account WHERE account_id = 'acc-1'"));

    expect(await each((person) => entriesOf(person))).toEqual({
      ann: ['acc-2 createEdit'],
      ben: [],
      admin: ['acc-2 createEdit'],
      nobody: [],
    });

    expect((await historyOf('admin', byKey('acc-1'))).text).toBe(EMPTY);
  });

  it('ontology/object-edits/edit-history#security: the latest delete entry decides, not an earlier one', async () => {
    await create('acc-1', 'user_ann');

    await remove('acc-1');

    await create('acc-1', 'user_ben');

    await remove('acc-1');

    const latest = ['acc-1 createEdit', 'acc-1 deleteEdit'];

    expect(await each((person) => entriesOf(person))).toEqual({ ann: [], ben: latest, admin: latest, nobody: [] });
  });
});

describe('ontology/object-edits/edit-history#security: only the delete entries of the Object Type decide', () => {
  async function deleteEntry(
    objectType: string,
    key: string,
    ownerId: string,
    operationId: string,
    at = '2026-01-01T00:00:00Z',
  ): Promise<void> {
    const entry = {
      operationId,
      userId: 'user_admin',
      edit: { type: 'deleteEdit', previousProperties: { accountId: key, ownerId, viewers: ['reviewer'] } },
    };

    await service.db.query(
      sql(
        'INSERT INTO ontology_1_engine.edit_history (object_type, primary_key, entry, created_at) VALUES ($1, $2, $3::jsonb, $4::timestamptz)',
        objectType,
        key,
        JSON.stringify(entry),
        at,
      ),
    );
  }

  it('ontology/object-edits/edit-history#security: a later delete entry of another Object Type with the same key does not decide', async () => {
    await create('acc-1', 'user_carl');

    await remove('acc-1');

    await deleteEntry(ENGAGEMENT, 'acc-1', 'user_ann', 'op-other', '2999-01-01T00:00:00Z');

    expect(await each((person) => entriesOf(person))).toEqual({
      ann: [],
      ben: [],
      admin: ['acc-1 createEdit', 'acc-1 deleteEdit'],
      nobody: [],
    });

    expect((await historyOf('ann', byKey('acc-1'))).text).toBe(EMPTY);
  });

  it.each([
    ['ann first', ['ann', 'ben']],
    ['ben first', ['ben', 'ann']],
  ] as const)(
    'ontology/object-edits/edit-history#security: of 2 delete entries at the same time, the one with the larger Action ID decides, whatever the order of the writes (%s)',
    async (_name, order) => {
      const owners = { ann: ['user_ann', 'op-a'], ben: ['user_ben', 'op-b'] } as const;

      for (const person of order) await deleteEntry(ACCOUNT, 'acc-tie', owners[person][0], owners[person][1]);

      const latest = ['acc-tie deleteEdit'];

      expect(await each((person) => entriesOf(person))).toEqual({ ann: [], ben: latest, admin: latest, nobody: [] });
    },
  );
});

describe('service/storage#object-edit-history: the row from a delete entry round-trips each String and String array value', () => {
  const ROWS: readonly {
    readonly accountId: string;
    readonly ownerId: string | null;
    readonly viewers: (string | null)[] | null;
  }[] = [
    { accountId: 'r-odd-owner', ownerId: QUOTED_CHARACTERS, viewers: ['reviewer'] },
    { accountId: 'r-odd-viewer', ownerId: 'user_carl', viewers: ['a,b', QUOTED_CHARACTERS, '{}'] },
    { accountId: 'r-null-text', ownerId: 'user_carl', viewers: ['NULL'] },
    { accountId: 'r-null-text-owner', ownerId: 'NULL', viewers: ['reviewer'] },
    { accountId: 'r-empty-string', ownerId: '', viewers: ['member'] },
    { accountId: 'r-no-owner', ownerId: null, viewers: ['member'] },
    { accountId: 'r-empty-array', ownerId: 'user_ann', viewers: [] },
    { accountId: 'r-null-array', ownerId: 'user_ann', viewers: [null] },
    { accountId: 'r-no-viewers', ownerId: 'user_ann', viewers: null },
    { accountId: 'r-null-and-value', ownerId: 'user_carl', viewers: [null, 'member'] },
  ];

  async function loaded(person: Person): Promise<string[]> {
    const answer = await post(
      'objectSets/loadObjects',
      {
        objectSet: { type: 'base', objectType: ACCOUNT },
        select: ['accountId'],
        orderBy: { fields: [{ field: 'accountId', direction: 'asc' }] },
      },
      person,
    );

    return (JSON.parse(answer.text) as { data: { accountId: string }[] }).data.map((object) => object.accountId);
  }

  it('service/storage#object-edit-history: after a delete, each person sees the entries of the Objects that they loaded before the delete', async () => {
    await insertObjects(
      service.db,
      ACCOUNT,
      ROWS.map((row) => ({ ...row, name: row.accountId, phase: 'customer' })),
    );

    const before = await each(loaded, EVERYONE);

    expect(before).toEqual({
      ann: ['r-empty-string', 'r-null-and-value'],
      ben: ['r-empty-string', 'r-null-and-value'],
      admin: ['r-empty-string', 'r-null-and-value', 'r-null-text', 'r-null-text-owner', 'r-odd-owner', 'r-odd-viewer'],
      nobody: [],
    });

    await deleteWithEntries(ROWS.map((row) => row.accountId));

    const after = await each(
      async (person) => (await entriesOf(person)).map((entry) => entry.replace(' deleteEdit', '')).sort(),
      EVERYONE,
    );

    expect(after).toEqual(before);

    expect({ odd: await readerEntries(ODD_PEOPLE.odd), null: await readerEntries(ODD_PEOPLE.null) }).toEqual({
      odd: ['r-odd-owner deleteEdit', 'r-odd-viewer deleteEdit'],
      null: ['r-null-text deleteEdit', 'r-null-text-owner deleteEdit'],
    });
  });

  async function deleteWithEntries(keys: readonly string[]): Promise<void> {
    const rows = await service.db.query<{
      account_id: string;
      name: string;
      phase: string;
      owner_id: string | null;
      viewers: (string | null)[] | null;
    }>(
      sql(
        'SELECT account_id, name, phase, owner_id, viewers FROM ontology_1_objects.account WHERE account_id = ANY($1::text[])',
        keys,
      ),
    );

    const stored = new Map(
      rows.map((row) => [
        row.account_id,
        new Map<string, JsonValue>([
          ['accountId', row.account_id],
          ['name', row.name],
          ['phase', row.phase],
          ['ownerId', row.owner_id],
          ['viewers', row.viewers],
        ]),
      ]),
    );

    const edits = keys.map(
      (primaryKey): Edit => ({ type: 'deleteObject', object: { objectType: ACCOUNT, primaryKey } }) as Edit,
    );

    const ontology = compiledOntology();

    const entries = historyEntries(
      orThrow(checkValues(edits, ontology, 'rules')),
      ontology,
      { operationId: 'op-delete', actionTypeRid: 'ri.delete', userId: 'user_admin' },
      (object) => stored.get(object.primaryKey) ?? new Map(),
    );

    const { writer } = bindReader(
      { object: 'ontology_1_objects', engine: 'ontology_1_engine' },
      { userId: UserId.parse('user_admin'), permissions: [], attributes: new Map() },
    );

    await service.db.query(entriesSql(writer, entries));

    await service.db.query(sql('DELETE FROM ontology_1_objects.account WHERE account_id = ANY($1::text[])', keys));
  }
});

describe('service/storage#object-edit-history: a delete entry whose JSON form is not the column type of today hides the Object from each person', () => {
  async function deleteEntry(
    accountId: string,
    previousProperties: Record<string, unknown> | undefined,
  ): Promise<void> {
    const edit =
      previousProperties === undefined
        ? { type: 'deleteEdit' }
        : { type: 'deleteEdit', previousProperties: { accountId, ...previousProperties } };

    await service.db.query(
      sql(
        'INSERT INTO ontology_1_engine.edit_history (object_type, primary_key, entry) VALUES ($1, $2, $3::jsonb)',
        ACCOUNT,
        accountId,
        JSON.stringify({ operationId: `op-${accountId}`, userId: 'user_admin', edit }),
      ),
    );
  }

  const FORMS: readonly (readonly [string, Record<string, unknown> | undefined])[] = [
    ['a String in the array Property', { ownerId: 'user_carl', viewers: 'member' }],
    ['the text {member} in the array Property', { ownerId: 'user_carl', viewers: '{member}' }],
    ['a number in the array Property', { ownerId: 'user_ann', viewers: 5 }],
    ['an object in the array Property', { ownerId: 'user_ann', viewers: { member: true } }],
    ['a boolean in the array Property', { ownerId: 'user_ann', viewers: true }],
    ['a nested array in the array Property', { ownerId: 'user_carl', viewers: [['member']] }],
    ['a number item in the array Property', { ownerId: 'user_carl', viewers: ['member', 5] }],
    ['an object item in the array Property', { ownerId: 'user_carl', viewers: ['member', { a: 1 }] }],
    ['a boolean item in the array Property', { ownerId: 'user_carl', viewers: ['member', true] }],
    ['an array in the String Property', { ownerId: ['user_ann'], viewers: ['member'] }],
    ['a number in the String Property', { ownerId: 5, viewers: ['member'] }],
    ['an object in the String Property', { ownerId: { id: 'user_ann' }, viewers: ['member'] }],
    ['a boolean in the String Property', { ownerId: true, viewers: ['member'] }],
    ['no key of a policy Property, as for a Property added after the delete or renamed', { viewers: ['member'] }],
    ['no previousProperties, as for an entry of a time before the policy', undefined],
  ];

  it.each(FORMS)(
    'service/storage#object-edit-history ontology/object-edits/edit-history#security: %s hides the entry from each person, admin too, with the bytes of a key with no history',
    async (_name, previous) => {
      await deleteEntry('acc-bad', previous);

      for (const person of EVERYONE) {
        const byKey = await historyOf(person, {
          objectPrimaryKey: { accountId: { type: 'stringValue', value: 'acc-bad' } },
        });

        expect({ person, status: byKey.status, text: byKey.text }).toEqual({ person, status: 200, text: EMPTY });

        expect({ person, text: (await historyOf(person)).text }).toEqual({ person, text: EMPTY });
      }
    },
  );

  it('service/storage#object-edit-history: the same entry with the forms of today shows to the owner, so the forms above fail by their form alone', async () => {
    await deleteEntry('acc-bad', { ownerId: 'user_ann', viewers: ['member', null] });

    expect(await each((person) => entriesOf(person))).toEqual({
      ann: ['acc-bad deleteEdit'],
      ben: ['acc-bad deleteEdit'],
      admin: ['acc-bad deleteEdit'],
      nobody: [],
    });
  });
});

describe('ontology/object-edits/edit-history#security: the route removes each hidden entry in its SQL, so each page stays full', () => {
  async function seedMixed(): Promise<void> {
    for (const [key, owner] of [
      ['acc-1', 'user_ann'],
      ['acc-2', 'user_ben'],
      ['acc-3', 'user_ann'],
      ['acc-4', 'user_ben'],
      ['acc-5', 'user_ann'],
    ] as const) {
      await create(key, owner);

      await reassign(key, owner);
    }

    await remove('acc-4');
  }

  async function pagesOf(person: Person, pageSize: number): Promise<string[]> {
    const pages: string[] = [];
    let pageToken: string | undefined;

    do {
      const answer = await historyOf(person, { pageSize, ...(pageToken ? { pageToken } : {}) });

      pages.push(answer.text);

      pageToken = (JSON.parse(answer.text) as { nextPageToken?: string }).nextPageToken;
    } while (pageToken !== undefined && pages.length < 20);

    return pages;
  }

  it("ontology/object-edits/edit-history#security: each page of ann is full, and the pages, the counts, and the tokens are the bytes of an Ontology with no Object of ben's", async () => {
    await seedMixed();

    const pages = await pagesOf('ann', 2);

    expect(pages.map((page) => (JSON.parse(page) as { totalCount: number }).totalCount)).toEqual([2, 2, 2]);

    const withOthers = {
      pages,
      all: (await historyOf('ann')).text,
      nobody: (await historyOf('nobody', { pageSize: 2 })).text,
    };

    await service.db.query(sql("DELETE FROM ontology_1_engine.edit_history WHERE primary_key IN ('acc-2', 'acc-4')"));

    await service.db.query(sql("DELETE FROM ontology_1_objects.account WHERE account_id IN ('acc-2', 'acc-4')"));

    expect({
      pages: await pagesOf('ann', 2),
      all: (await historyOf('ann')).text,
      nobody: (await historyOf('nobody', { pageSize: 2 })).text,
    }).toEqual(withOthers);

    expect(withOthers.nobody).toBe(EMPTY);
  });

  it('ontology/object-edits/edit-history#security: an operationIds filter and a time filter read only the visible entries', async () => {
    await create('acc-1', 'user_ann');

    await create('acc-2', 'user_ben');

    const ids = await service.db.query<{ id: string }>(
      sql("SELECT entry ->> 'operationId' AS id FROM ontology_1_engine.edit_history ORDER BY primary_key"),
    );

    const operationIds = ids.map((row) => row.id);

    expect(await entriesOf('ann', { filters: { type: 'operationIdsFilter', operationIds } })).toEqual([
      'acc-1 createEdit',
    ]);

    expect(await entriesOf('ann', { filters: { type: 'timestampFilter', startTime: '2000-01-01T00:00:00Z' } })).toEqual(
      ['acc-1 createEdit'],
    );

    expect(
      (await historyOf('ann', { filters: { type: 'operationIdsFilter', operationIds: operationIds.slice(1) } })).text,
    ).toBe(EMPTY);
  });
});

describe('ontology/object-edits/edit-history#security: an entry always shows the userId of the editor', () => {
  it('ontology/object-edits/edit-history#security: ann sees the userId of admin, who wrote the entry', async () => {
    await create('acc-1', 'user_ann');

    const page = JSON.parse((await historyOf('ann')).text) as { data: { userId: string }[] };

    expect(page.data.map((entry) => entry.userId)).toEqual(['user_admin']);
  });
});

describe('ontology/object-edits/edit-history#security: the MCP tool get_edit_history shows the same entries as the route', () => {
  it('ontology/object-edits/edit-history#security: get_edit_history as each person gives the data of the route as that person', async () => {
    await create('acc-1', 'user_ann');

    await create('acc-2', 'user_ben');

    for (const person of ['ann', 'ben', 'nobody'] as const) {
      const tool = await service.tool(
        'get_edit_history',
        { objectType: ACCOUNT, sortOrder: 'oldest_first' },
        PEOPLE[person],
      );

      const route = JSON.parse((await historyOf(person)).text) as { data: unknown[] };

      expect(structuredOf(tool.body)).toEqual(JSON.parse((await historyOf(person)).text));

      expect(route.data.length).toBe(person === 'nobody' ? 0 : 1);
    }

    const ann = await service.tool(
      'get_edit_history',
      { objectType: ACCOUNT, objectPrimaryKey: { accountId: 'acc-2' } },
      PEOPLE.ann,
    );

    expect(structuredOf(ann.body)).toEqual({ data: [], totalCount: 0 });
  });
});

describe('ontology/object-edits/edit-history#security: a Property value that a property security policy hides is cut from each entry', () => {
  const onlyRole = (permission: string): Policy => ({
    kind: 'compare',
    object: { kind: 'constant', values: [permission] },
    operator: 'intersects',
    person: { kind: 'permissions' },
  });

  const OWNER: Policy = {
    kind: 'compare',
    object: { kind: 'property', property: 'ownerId' },
    operator: 'equal',
    person: { kind: 'userId' },
  };

  function withPolicies(apiName: string, policies: Readonly<Record<string, Policy>>): CompiledObjectType {
    const objectType = compiledOntology().objectTypes.get(apiName);

    if (!objectType) throw new Error(`No ${apiName}.`);

    const properties = new Map(
      [...objectType.properties].map(([name, property]) => [
        name,
        policies[name] ? { ...property, policy: policies[name] } : property,
      ]),
    );

    return { ...objectType, properties };
  }

  const account = () => withPolicies(ACCOUNT, { name: onlyRole('admin'), phase: OWNER });

  async function read(
    objectType: CompiledObjectType,
    person: Person,
    body: object = {},
  ): Promise<{ edit: Record<string, unknown>; userId: string; objectPrimaryKey: Record<string, { value: string }> }[]> {
    const request = orThrow(readHistoryRequest({ sortOrder: 'oldest_first', ...body }, objectType));

    const { reader } = bindReader(
      { object: 'ontology_1_objects', engine: 'ontology_1_engine' },
      { userId: UserId.parse(PEOPLE[person].claims.sub), permissions: ROLE_OF[person], attributes: new Map() },
    );

    const rows = await service.db.query<HistoryRow>(historySql(reader, objectType, request));

    return rows.slice(0, request.pageSize).map((row) => historyEntry(row, request, objectType) as never);
  }

  async function keysOf(objectType: CompiledObjectType, person: Person, body: object = {}): Promise<string[]> {
    return (await read(objectType, person, body)).map(({ edit }) => {
      const keys = (field: string) =>
        Object.keys((edit[field] ?? {}) as object)
          .sort()
          .join(',');

      return `${String(edit['type'])} [${keys('properties')}] [${keys('previousProperties')}]`;
    });
  }

  it('ontology/object-edits/edit-history#security: name and phase are cut from properties and previousProperties, and userId stays', async () => {
    await create('acc-1', 'user_ann', ['member']);

    await reassign('acc-1', 'user_ann', ['member']);

    expect(await each((person) => keysOf(account(), person), ['ann', 'ben', 'admin'])).toEqual({
      ann: ['createEdit [ownerId,phase,viewers] []', 'modifyEdit [ownerId,phase,viewers] [ownerId,phase,viewers]'],
      ben: ['createEdit [ownerId,viewers] []', 'modifyEdit [ownerId,viewers] [ownerId,viewers]'],
      admin: ['createEdit [name,ownerId,viewers] []', 'modifyEdit [ownerId,viewers] [ownerId,viewers]'],
    });

    expect((await read(account(), 'ben')).map((entry) => entry.userId)).toEqual(['user_admin', 'user_admin']);
  });

  it('ontology/object-edits/edit-history#security: with includeAllPreviousProperties: true, the route cuts the same hidden Properties', async () => {
    await create('acc-1', 'user_ann', ['member']);

    await reassign('acc-1', 'user_ann', ['member']);

    const all = { includeAllPreviousProperties: true };

    expect(await each((person) => keysOf(account(), person, all), ['ann', 'ben', 'admin'])).toEqual({
      ann: [
        'createEdit [ownerId,phase,viewers] []',
        'modifyEdit [ownerId,phase,viewers] [accountId,ownerId,phase,viewers]',
      ],
      ben: ['createEdit [ownerId,viewers] []', 'modifyEdit [ownerId,viewers] [accountId,ownerId,viewers]'],
      admin: ['createEdit [name,ownerId,viewers] []', 'modifyEdit [ownerId,viewers] [accountId,name,ownerId,viewers]'],
    });
  });

  it('ontology/object-edits/edit-history#security: a reassignment shows the past phase values to the new owner and hides them from the old one, and a delete entry decides after a delete', async () => {
    await create('acc-1', 'user_ann', ['member']);

    await reassign('acc-1', 'user_ben', ['member']);

    expect(await each((person) => keysOf(account(), person), ['ann', 'ben'])).toEqual({
      ann: ['createEdit [ownerId,viewers] []', 'modifyEdit [ownerId,viewers] [ownerId,viewers]'],
      ben: ['createEdit [ownerId,phase,viewers] []', 'modifyEdit [ownerId,phase,viewers] [ownerId,phase,viewers]'],
    });

    await remove('acc-1');

    expect((await keysOf(account(), 'ben')).at(-1)).toBe('deleteEdit [] [accountId,ownerId,phase,viewers]');

    expect((await keysOf(account(), 'ann')).at(-1)).toBe('deleteEdit [] [accountId,ownerId,viewers]');
  });

  it('ontology/object-edits/edit-history#security: on a type with an object policy and property policies, a hidden Object and a hidden deleted Object show no entry', async () => {
    await create('acc-1', 'user_carl');

    await create('acc-2', 'user_carl');

    await remove('acc-2');

    await create('acc-3', 'user_ann');

    await create('acc-4', 'user_ann');

    await remove('acc-4');

    const keys = async (person: Person) =>
      (await read(account(), person)).map(
        (entry) => `${entry.objectPrimaryKey['accountId']?.value ?? ''} ${String(entry.edit['type'])}`,
      );

    expect(await each(keys, ['ann', 'ben'])).toEqual({
      ann: ['acc-3 createEdit', 'acc-4 createEdit', 'acc-4 deleteEdit'],
      ben: [],
    });
  });

  it('ontology/object-edits/edit-history#security: the cut removes no entry, so each page stays full and the page token does not change', async () => {
    await create('acc-1', 'user_ann', ['member']);

    await create('acc-2', 'user_ann', ['member']);

    await create('acc-3', 'user_ann', ['member']);

    const plain = compiledOntology().objectTypes.get(ACCOUNT);

    if (!plain) throw new Error('No Account.');

    const page = async (objectType: CompiledObjectType) => {
      const request = orThrow(readHistoryRequest({ pageSize: 2 }, objectType));

      const { reader } = bindReader(
        { object: 'ontology_1_objects', engine: 'ontology_1_engine' },
        { userId: UserId.parse('user_ben'), permissions: ROLES.member, attributes: new Map() },
      );

      return (await service.db.query<HistoryRow>(historySql(reader, objectType, request))).map((row) => [
        row.time,
        row.primaryKey,
        row.operationId,
      ]);
    };

    expect(await page(account())).toEqual(await page(plain));

    expect((await page(account())).length).toBe(3);
  });

  it('ontology/object-edits/edit-history#security: on a type with only property policies, an Object with no current row and no delete entry shows no entry', async () => {
    await apply('create-engagement', { engagementId: 'eng-1', accountId: 'acc-1', title: 'One', amount: 1 });

    await apply('create-engagement', { engagementId: 'eng-2', accountId: 'acc-1', title: 'Two', amount: 2 });

    await service.db.query(sql("DELETE FROM ontology_1_objects.engagement WHERE engagement_id = 'eng-1'"));

    const engagement = withPolicies(ENGAGEMENT, { accountId: onlyRole('member') });

    expect((await read(engagement, 'ann')).map((entry) => entry.objectPrimaryKey['engagementId']?.value)).toEqual([
      'eng-2',
    ]);
  });

  it('ontology/object-edits/edit-history#security: a foreign key Property follows its own policy, and the route does not check the linked Object', async () => {
    await create('acc-1', 'user_carl');

    await apply('create-engagement', { engagementId: 'eng-1', accountId: 'acc-1', title: 'One', amount: 1 });

    const engagement = withPolicies(ENGAGEMENT, { accountId: onlyRole('member') });

    expect(await each((person) => keysOf(engagement, person), ['ann', 'admin'])).toEqual({
      ann: ['createEdit [accountId,amount,createdAt,status,title] []'],
      admin: ['createEdit [amount,createdAt,status,title] []'],
    });

    expect(await entriesOf('ann')).toEqual([]);
  });
});

const ROLE_OF: Readonly<Record<Person, readonly string[]>> = {
  ann: ROLES.member,
  ben: ROLES.member,
  admin: ROLES.admin,
  nobody: ROLES.guest,
};

async function readerEntries(userId: string): Promise<string[]> {
  const objectType = compiledOntology().objectTypes.get(ACCOUNT);

  if (!objectType) throw new Error('No Account.');

  const request = orThrow(readHistoryRequest({ sortOrder: 'oldest_first' }, objectType));

  const { reader } = bindReader(SCHEMAS, {
    userId: UserId.parse(userId),
    permissions: ROLES.guest,
    attributes: new Map(),
  });

  const rows = await service.db.query<HistoryRow>(historySql(reader, objectType, request));

  return rows.map((row) => {
    const { edit } = historyEntry(row, request, objectType) as {
      edit: { type: string; properties?: { accountId: string }; previousProperties?: { accountId: string } };
    };

    return `${(edit.properties ?? edit.previousProperties)?.accountId ?? ''} ${edit.type}`;
  });
}

function structuredOf(body: unknown): unknown {
  return (body as { result: { structuredContent: unknown } }).result.structuredContent;
}

function compiledOntology(): CompiledOntology {
  return compileOrThrow(stored(historyIr(), { functions: twinFunctions('0.6.3') }));
}
