import type {
  OntologyIr,
  OntologyIrActionTypeBlockDataV2,
  OntologyIrLinkTypeBlockDataV2,
  OntologyIrObjectTypeBlockDataV2,
  OntologyIrPropertyType,
} from '@osdk/client.unstable';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createPool } from '../db/index.ts';
import { createDb, type Db, fallibleOf } from '../db/promise.test-utils.ts';
import type { HandleInput } from '../handler/index.ts';
import type { PublishedFunctions, SchemaMigration } from './index.ts';
import {
  accountWith,
  grantsOf,
  irOf,
  NS,
  propertyOfType,
  stringProperty,
  twinFunctions,
  twinIr,
  twinObjectType,
  unchecked,
} from '../ontology/stored.test-utils.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { installOnce } from '../install.test-utils.ts';
import { noUsers, TEST_ONTOLOGY_RID, testSettings } from '../service.test-utils.ts';
import { createTestIssuer, type TestIssuer } from '../tokens.test-utils.ts';
import { LISTED_SET } from './releasesSupport.test-utils.ts';
import {
  columnsOf,
  insertObjects,
  newDatabase,
  sql,
  type TestDatabase,
  expectAllOnNewest,
} from './publish.test-utils.ts';
import { buffered } from '../routeHarness.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';

let postgres: TestPostgres;
let issuer: TestIssuer;
let database: TestDatabase;
let pooledDb: Db;
let endPooled: () => Promise<void>;
let consoleLog: MockInstance<typeof console.log>;

beforeAll(async () => {
  await import('../handler/index.ts');

  postgres = await startPostgres();

  issuer = await createTestIssuer(testSettings.auth);
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  database = await newDatabase(postgres.url);

  const pool = createPool(database.url);

  pooledDb = createDb(pool);

  endPooled = () => pool.end();

  consoleLog = vi.spyOn(console, 'log');
});

afterEach(async () => {
  await expectAllOnNewest(database.db);

  consoleLog.mockRestore();

  await endPooled();

  await database.end();
});

interface Options {
  readonly validateOnly?: boolean;
  readonly migrations?: readonly SchemaMigration[];
  readonly functions?: PublishedFunctions;
}

async function publish(ir: OntologyIr, options: Options = {}): Promise<Response> {
  vi.resetModules();

  const { handle } = await import('../handler/index.ts');

  const input: HandleInput = {
    db: fallibleOf(pooledDb),
    directDb: fallibleOf(database.db),
    settings: testSettings,
    keys: issuer.keys,
    users: noUsers,
    workos: stubPublish(),
  };

  const { validateOnly = false, migrations = [], functions } = options;

  const body = {
    ir,
    product: 'twin',
    schemaMigrations: { migrations },
    osdkSet: LISTED_SET,
    grants: grantsOf(ir),
    validateOnly,
    ...(functions ? { functions } : {}),
  };

  const request = new Request('http://localhost/api/ontology-service/v1/publish', {
    method: 'POST',
    headers: { authorization: `Bearer ${await issuer.github()}` },
    body: JSON.stringify(body),
  });

  const response = await buffered(handle(request, input));

  if (response.status === 200 && !validateOnly) await installOnce(database.db, TEST_ONTOLOGY_RID, 'twin');

  return response;
}

async function validateChange(
  before: OntologyIr,
  after: OntologyIr,
  migrations: readonly SchemaMigration[] = [],
): Promise<Response> {
  expect((await publish(before)).status).toBe(200);

  return publish(after, { validateOnly: true, migrations });
}

async function expectActiveStatus(response: Response, change: string): Promise<void> {
  expect(response.status).toBe(400);

  expect(await response.json()).toEqual({
    errorCode: 'INVALID_ARGUMENT',
    errorName: 'Default:InvalidArgument',
    errorInstanceId: expect.any(String),
    parameters: { change, status: 'active', requiredStatus: 'deprecated' },
  });
}

type Status = 'active' | 'experimental' | 'deprecated';

function statusBlock(status: Status): unknown {
  if (status === 'active') return { type: 'active', active: {} };

  if (status === 'experimental') return { type: 'experimental', experimental: {} };

  return { type: 'deprecated', deprecated: { message: 'Use the new one.', deadline: '2027-01-01T00:00:00Z' } };
}

const ACCOUNT = `${NS}Account`;
const CREATE_ACCOUNT = `${NS}create-account`;

interface Parameter {
  readonly id: string;
  readonly type: 'string' | 'integer';
  readonly required: boolean;
}

function accountIr(status: Status, ...parameters: Parameter[]): OntologyIr {
  const block = structuredClone(
    twinIr('0.4.0').ontology.actionTypes[CREATE_ACCOUNT],
  ) as OntologyIrActionTypeBlockDataV2;

  const { metadata, actionTypeLogic } = block.actionType;

  metadata.status = unchecked(statusBlock(status));

  for (const { id, type, required } of parameters) {
    metadata.parameters[id] = unchecked({
      id,
      type: { type, [type]: {} },
      displayMetadata: { displayName: id, description: '', typeClasses: [] },
    });

    const allowedValues =
      type === 'string'
        ? { type: 'text', text: { type: 'text', text: {} } }
        : { type: 'range', range: { type: 'range', range: {} } };

    actionTypeLogic.validation.parameterValidations[id] = unchecked({
      defaultValidation: {
        display: { renderHint: { type: 'textInput', textInput: {} }, visibility: { type: 'editable', editable: {} } },
        validation: {
          allowedValues,
          required: required ? { type: 'required', required: {} } : { type: 'notRequired', notRequired: {} },
        },
      },
      conditionalOverrides: [],
    });
  }

  const ir = irOf(twinObjectType('Account'));

  return { ...ir, ontology: { ...ir.ontology, actionTypes: { [CREATE_ACCOUNT]: block } } };
}

const notes = (type: Parameter['type'], required: boolean): Parameter => ({ id: 'notes', type, required });

describe('the status of a deleted Action Type', () => {
  it('ontology/action-types/action-types#statuses: an active Action Type cannot be deleted', async () => {
    const response = await validateChange(accountIr('active'), irOf(twinObjectType('Account')));

    await expectActiveStatus(response, `Delete Action Type ${CREATE_ACCOUNT}`);
  });

  it('ontology/action-types/action-types#statuses: an active Action Type cannot be renamed', async () => {
    const renamed = accountIr('active');
    const block = renamed.ontology.actionTypes[CREATE_ACCOUNT];

    if (!block) throw new Error('The IR has no create-account.');

    block.actionType.metadata.apiName = `${NS}open-account`;

    const response = await validateChange(accountIr('active'), {
      ...renamed,
      ontology: { ...renamed.ontology, actionTypes: { [`${NS}open-account`]: block } },
    });

    await expectActiveStatus(response, `Delete Action Type ${CREATE_ACCOUNT}`);
  });

  for (const status of ['deprecated', 'experimental'] as const) {
    it(`ontology/action-types/action-types#statuses: a ${status} Action Type can be deleted`, async () => {
      const response = await validateChange(accountIr(status), irOf(twinObjectType('Account')));

      expect(response.status).toBe(200);

      expect(await response.json()).toMatchObject({
        changes: [{ description: `Delete Action Type ${CREATE_ACCOUNT}` }],
      });
    });
  }
});

describe('the parameters of an Action Type', () => {
  const of = `of Action Type ${CREATE_ACCOUNT}`;

  const breaking: readonly { name: string; before: Parameter[]; after: Parameter[]; change: string }[] = [
    {
      name: 'a new required parameter',
      before: [],
      after: [notes('string', true)],
      change: `Create required parameter notes ${of}`,
    },
    {
      name: 'a removed parameter',
      before: [notes('string', false)],
      after: [],
      change: `Delete parameter notes ${of}`,
    },
    {
      name: 'a renamed parameter',
      before: [notes('string', false)],
      after: [{ id: 'remarks', type: 'string', required: false }],
      change: `Delete parameter notes ${of}`,
    },
    {
      name: 'a changed parameter type',
      before: [notes('string', false)],
      after: [notes('integer', false)],
      change: `Change the type of parameter notes ${of}`,
    },
    {
      name: 'an optional parameter that becomes required',
      before: [notes('string', false)],
      after: [notes('string', true)],
      change: `Make parameter notes required ${of}`,
    },
  ];

  for (const { name, before, after, change } of breaking) {
    it(`ontology/action-types/action-types#statuses: ${name} is refused on an active Action Type`, async () => {
      await expectActiveStatus(
        await validateChange(accountIr('active', ...before), accountIr('active', ...after)),
        change,
      );
    });

    for (const status of ['deprecated', 'experimental'] as const) {
      it(`ontology/action-types/action-types#statuses: ${name} is accepted on a ${status} Action Type`, async () => {
        expect((await validateChange(accountIr(status, ...before), accountIr(status, ...after))).status).toBe(200);
      });
    }
  }

  it('ontology/action-types/action-types#statuses: a new optional parameter is accepted on an active Action Type', async () => {
    expect((await validateChange(accountIr('active'), accountIr('active', notes('string', false)))).status).toBe(200);
  });

  it('ontology/action-types/action-types#statuses: a required parameter that becomes optional is accepted on an active Action Type', async () => {
    expect(
      (await validateChange(accountIr('active', notes('string', true)), accountIr('active', notes('string', false))))
        .status,
    ).toBe(200);
  });

  it('ontology/action-types/action-types#statuses: a validateOnly publish with no Functions does not check the parameters of an active function-backed Action Type', async () => {
    const ir = twinIr('0.4.0');

    expect((await publish(ir, { functions: twinFunctions('0.4.0') })).status).toBe(200);

    expect((await publish(ir, { validateOnly: true })).status).toBe(200);
  });

  it('ontology/action-types/action-types#statuses: a validateOnly publish with the Functions checks the parameters of an active function-backed Action Type', async () => {
    const ir = twinIr('0.4.0');
    const functions = twinFunctions('0.4.0');

    expect((await publish(ir, { functions })).status).toBe(200);

    const fewer: PublishedFunctions = {
      ...functions,
      discovered: functions.discovered.map((fn) => ({
        ...fn,
        inputs: fn.inputs.filter((input) => input.name !== 'reason'),
      })),
    };

    await expectActiveStatus(
      await publish(ir, { validateOnly: true, functions: fewer }),
      `Delete parameter reason of Action Type ${NS}close-account-action`,
    );
  });
});

function accountWithNotes(type: 'string' | 'integer', status: Status): OntologyIrObjectTypeBlockDataV2 {
  const property: OntologyIrPropertyType =
    type === 'string' ? stringProperty('notes') : propertyOfType('notes', { type: 'integer', integer: {} });

  property.status = unchecked(statusBlock(status));

  return accountWith(property);
}

describe('the status of a Property whose base type changes', () => {
  const change = `Change the base type of Property notes of Object Type ${ACCOUNT}`;
  const drop: SchemaMigration = { type: 'dropProperty', objectType: ACCOUNT, property: 'notes' };

  it('ontology/object-edits/schema-migrations#edge-rules: the base type of an active Property cannot change', async () => {
    await expectActiveStatus(
      await validateChange(irOf(accountWithNotes('string', 'active')), irOf(accountWithNotes('integer', 'active'))),
      change,
    );
  });

  it('ontology/object-edits/schema-migrations#edge-rules: the base type of an active Property cannot change, also with a Drop', async () => {
    await expectActiveStatus(
      await validateChange(irOf(accountWithNotes('string', 'active')), irOf(accountWithNotes('integer', 'active')), [
        drop,
      ]),
      change,
    );
  });

  for (const status of ['deprecated', 'experimental'] as const) {
    it(`ontology/object-edits/schema-migrations#edge-rules: the base type of a ${status} Property can change`, async () => {
      const response = await validateChange(
        irOf(accountWithNotes('string', status)),
        irOf(accountWithNotes('integer', status)),
      );

      expect(response.status).toBe(200);

      expect(await response.json()).toMatchObject({
        changes: expect.arrayContaining([expect.objectContaining({ description: change })]),
      });
    });
  }
});

function linkedIr(status: Status, side = 'engagements'): OntologyIr {
  const block = structuredClone(
    twinIr('0.4.0').ontology.linkTypes['account-to-engagements'],
  ) as OntologyIrLinkTypeBlockDataV2;

  block.linkType.status = unchecked(statusBlock(status));

  const definition = block.linkType.definition;

  if (definition.type !== 'oneToMany') throw new Error('The twin Link Type is not one-to-many.');

  definition.oneToMany.oneToManyLinkMetadata.apiName = side;

  const ir = irOf(twinObjectType('Account'), twinObjectType('Engagement'));

  return { ...ir, ontology: { ...ir.ontology, linkTypes: { 'account-to-engagements': block } } };
}

describe('the status of a Link Type whose side is renamed', () => {
  it('ontology/object-edits/schema-migrations#edge-rules: a side of an active Link Type cannot be renamed', async () => {
    await expectActiveStatus(
      await validateChange(linkedIr('active'), linkedIr('active', 'workOrders')),
      'Rename Link side engagements to workOrders of Link Type accountToEngagements',
    );
  });

  for (const status of ['deprecated', 'experimental'] as const) {
    it(`ontology/object-edits/schema-migrations#edge-rules: a side of a ${status} Link Type can be renamed`, async () => {
      expect((await validateChange(linkedIr(status), linkedIr(status, 'workOrders'))).status).toBe(200);
    });
  }
});

function accountKeyIr(
  primaryKey: string,
  options: { readonly nameRequired?: boolean; readonly extra?: readonly string[] } = {},
): OntologyIr {
  const block = twinObjectType('Account');
  const { nameRequired = true, extra = [] } = options;
  const name = stringProperty('name');

  if (nameRequired)
    name.dataConstraints = { propertyTypeConstraints: [], nullabilityV2: { noNulls: true, noEmptyCollections: false } };

  const properties: Record<string, OntologyIrPropertyType> = { id: stringProperty('id'), name };

  for (const apiName of extra) properties[apiName] = stringProperty(apiName);

  block.objectType.primaryKeys = [primaryKey];
  block.objectType.titlePropertyTypeRid = 'name';
  block.objectType.propertyTypes = properties;

  return irOf(block);
}

describe('a primary key change with a Drop of all Objects', () => {
  const dropAccounts: SchemaMigration = { type: 'dropAllPatches', objectType: ACCOUNT };

  async function primaryKeyColumns(): Promise<string[]> {
    const rows = await database.db.query<{ name: string }>(
      sql(
        `SELECT a.attname AS name FROM pg_index i
           JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
          WHERE n.nspname = 'ontology_1_objects' AND c.relname = 'account' AND i.indisprimary`,
      ),
    );

    return rows.map((row) => row.name);
  }

  async function nullable(column: string): Promise<'YES' | 'NO' | undefined> {
    return (await columnsOf(database.db, 'account')).find((c) => c.column_name === column)?.is_nullable;
  }

  it('ontology/object-edits/schema-migrations#edge-rules: a primary key change with a Drop of all Objects deletes rows with duplicate new keys before it changes the key', async () => {
    expect((await publish(accountKeyIr('id'))).status).toBe(200);

    await insertObjects(database.db, ACCOUNT, [
      { id: 'a1', name: 'Acme' },
      { id: 'a2', name: 'Acme' },
    ]);

    const response = await publish(accountKeyIr('name'), { migrations: [dropAccounts] });

    expect(response.status).toBe(200);

    expect(await response.json()).toMatchObject({
      version: 2,
      changes: [
        { description: `Change the primary key of Object Type ${ACCOUNT}`, migration: dropAccounts },
        { description: `Make Property id optional of Object Type ${ACCOUNT}` },
      ],
    });

    expect(await database.db.query(sql('SELECT count(*)::int AS count FROM ontology_1_objects.account'))).toEqual([
      { count: 0 },
    ]);

    expect(await primaryKeyColumns()).toEqual(['name']);

    expect(await nullable('id')).toBe('YES');
  });

  it('ontology/object-edits/schema-migrations#stored-data-checks: a primary key change to an optional Property with a Drop of all Objects deletes rows with no value before it sets NOT NULL', async () => {
    expect((await publish(accountKeyIr('id', { nameRequired: false }))).status).toBe(200);

    await insertObjects(database.db, ACCOUNT, [
      { id: 'a1', name: null },
      { id: 'a2', name: 'Acme' },
      { id: 'a3', name: 'Acme' },
    ]);

    const response = await publish(accountKeyIr('name', { nameRequired: false }), { migrations: [dropAccounts] });

    expect(response.status).toBe(200);

    expect(await response.json()).toMatchObject({
      version: 2,
      changes: [
        { description: `Make Property name required of Object Type ${ACCOUNT}` },
        { description: `Change the primary key of Object Type ${ACCOUNT}`, migration: dropAccounts },
        { description: `Make Property id optional of Object Type ${ACCOUNT}` },
      ],
    });

    expect(await database.db.query(sql('SELECT count(*)::int AS count FROM ontology_1_objects.account'))).toEqual([
      { count: 0 },
    ]);

    expect(await primaryKeyColumns()).toEqual(['name']);

    expect(await nullable('id')).toBe('YES');

    expect(await nullable('name')).toBe('NO');
  });

  it('ontology/object-edits/schema-migrations#edge-rules: a primary key change to a new Property with a Drop of all Objects deletes rows before it adds the new NOT NULL column', async () => {
    expect((await publish(accountKeyIr('id'))).status).toBe(200);

    await insertObjects(database.db, ACCOUNT, [
      { id: 'a1', name: 'Acme' },
      { id: 'a2', name: 'Acme' },
    ]);

    const response = await publish(accountKeyIr('code', { extra: ['code'] }), { migrations: [dropAccounts] });

    expect(response.status).toBe(200);

    expect(await response.json()).toMatchObject({
      version: 2,
      changes: [
        { description: `Create Property code of Object Type ${ACCOUNT}` },
        { description: `Change the primary key of Object Type ${ACCOUNT}`, migration: dropAccounts },
        { description: `Make Property id optional of Object Type ${ACCOUNT}` },
      ],
    });

    expect(await database.db.query(sql('SELECT count(*)::int AS count FROM ontology_1_objects.account'))).toEqual([
      { count: 0 },
    ]);

    expect(await primaryKeyColumns()).toEqual(['code']);

    expect(await nullable('id')).toBe('YES');

    expect(await nullable('code')).toBe('NO');
  });
});
