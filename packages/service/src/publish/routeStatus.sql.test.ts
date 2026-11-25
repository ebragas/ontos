import { readFileSync } from 'node:fs';
import type { OntologyIr, OntologyIrLinkTypeBlockDataV2, OntologyIrObjectTypeBlockDataV2 } from '@osdk/client.unstable';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createPool } from '../db/index.ts';
import { createDb, type Db, fallibleOf } from '../db/promise.test-utils.ts';
import type { HandleInput } from '../handler/index.ts';
import { type StoredOntologyVersion } from '../ontology/index.ts';
import {
  accountWith,
  compileOrThrow,
  grantsOf,
  irOf,
  stringProperty,
  twinIr,
  twinObjectType,
  unchecked,
} from '../ontology/stored.test-utils.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { installOnce } from '../install.test-utils.ts';
import { noUsers, TEST_ONTOLOGY_RID, testSettings } from '../service.test-utils.ts';
import type { SchemaMigration } from './index.ts';
import { createTestIssuer, type TestIssuer } from '../tokens.test-utils.ts';
import { LISTED_SET } from './releasesSupport.test-utils.ts';
import { newDatabase, sql, tablesOf, type TestDatabase, expectAllOnNewest } from './publish.test-utils.ts';
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

async function publish(ir: OntologyIr, migrations: readonly SchemaMigration[] = []): Promise<Response> {
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

  const request = new Request('http://localhost/api/ontology-service/v1/publish', {
    method: 'POST',
    headers: { authorization: `Bearer ${await issuer.github()}` },
    body: JSON.stringify({
      ir,
      product: 'twin',
      schemaMigrations: { migrations },
      osdkSet: LISTED_SET,
      grants: grantsOf(ir),
      validateOnly: false,
    }),
  });

  const response = await buffered(handle(request, input));

  if (response.status === 200) await installOnce(database.db, TEST_ONTOLOGY_RID, 'twin');

  return response;
}

function experimentalEngagement(): OntologyIrObjectTypeBlockDataV2 {
  const block = twinObjectType('Engagement');

  block.objectType.status = { type: 'experimental', experimental: {} };

  return block;
}

describe('the status of a deleted Object Type', () => {
  it('ontology/object-edits/schema-migrations#edge-rules: an Object Type that the IR marks experimental can be deleted', async () => {
    expect((await publish(irOf(twinObjectType('Account'), experimentalEngagement()))).status).toBe(200);

    const response = await publish(irOf(twinObjectType('Account')));

    expect(response.status).toBe(200);

    expect(await response.json()).toMatchObject({ version: 2 });

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual(['account']);
  });

  it('ontology/object-edits/schema-migrations#edge-rules: an Object Type that the IR marks active cannot be deleted', async () => {
    expect((await publish(irOf(twinObjectType('Account'), twinObjectType('Engagement')))).status).toBe(200);

    const response = await publish(irOf(twinObjectType('Account')));

    expect(response.status).toBe(400);

    expect(await response.json()).toEqual({
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'Default:InvalidArgument',
      errorInstanceId: expect.any(String),
      parameters: {
        change: 'Delete Object Type com.example.twin.Engagement',
        status: 'active',
        requiredStatus: 'deprecated',
      },
    });

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual(['account', 'engagement']);
  });
});

const ACCOUNT = 'com.example.twin.Account';

function accountWithNotes(status: 'active' | 'experimental'): OntologyIrObjectTypeBlockDataV2 {
  const notes = stringProperty('notes');

  notes.status = status === 'active' ? { type: 'active', active: {} } : { type: 'experimental', experimental: {} };

  return accountWith(notes);
}

function linkedIr(status: 'active' | 'experimental'): OntologyIr {
  const block = structuredClone(
    twinIr('0.4.0').ontology.linkTypes['account-to-engagements'],
  ) as OntologyIrLinkTypeBlockDataV2;

  block.linkType.status =
    status === 'active' ? { type: 'active', active: {} } : { type: 'experimental', experimental: {} };

  const ir = irOf(twinObjectType('Account'), twinObjectType('Engagement'));

  return { ...ir, ontology: { ...ir.ontology, linkTypes: { 'account-to-engagements': block } } };
}

describe('the status of a deleted Property or Link Type', () => {
  it('ontology/object-edits/schema-migrations#edge-rules: a Property that the IR marks active cannot be deleted, also with a Drop', async () => {
    expect((await publish(irOf(accountWithNotes('active')))).status).toBe(200);

    const drop: SchemaMigration = { type: 'dropProperty', objectType: ACCOUNT, property: 'notes' };

    const response = await publish(irOf(twinObjectType('Account')), [drop]);

    expect(response.status).toBe(400);

    expect(await response.json()).toEqual({
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'Default:InvalidArgument',
      errorInstanceId: expect.any(String),
      parameters: {
        change: 'Delete Property notes of Object Type com.example.twin.Account',
        status: 'active',
        requiredStatus: 'deprecated',
      },
    });
  });

  it('ontology/object-edits/schema-migrations#edge-rules: a Link Type that the IR marks active cannot be deleted', async () => {
    expect((await publish(linkedIr('active'))).status).toBe(200);

    const response = await publish(irOf(twinObjectType('Account'), twinObjectType('Engagement')));

    expect(response.status).toBe(400);

    expect(await response.json()).toMatchObject({
      parameters: { change: 'Delete Link Type accountToEngagements', status: 'active', requiredStatus: 'deprecated' },
    });
  });
});

const ENGAGEMENT = 'com.example.twin.Engagement';

const derivedIr = JSON.parse(
  readFileSync(new URL('../../twin/ir/derived.json', import.meta.url), 'utf8'),
) as OntologyIr;

function engagementEdited(
  edit: (block: {
    objectType: { propertyTypes: Record<string, unknown> };
    datasources: { datasource: { type: string; derived?: unknown } }[];
  }) => void,
): OntologyIr {
  const ir = structuredClone(derivedIr);

  edit(unchecked(ir.ontology.objectTypes[ENGAGEMENT]));

  return ir;
}

function invoiceCountWith(status: 'active' | 'experimental' | 'deprecated'): OntologyIr {
  return engagementEdited((block) => {
    Object.assign(unchecked<object>(block.objectType.propertyTypes['invoiceCount']), {
      status: {
        type: status,
        [status]: status === 'deprecated' ? { message: 'Use the Invoices.', deadline: '2027-01-01T00:00:00Z' } : {},
      },
    });
  });
}

const withoutInvoiceCount = () =>
  engagementEdited((block) => {
    delete block.objectType.propertyTypes['invoiceCount'];

    block.datasources = block.datasources.filter(({ datasource }) => datasource.type !== 'derived');
  });

const invoiceCountAsSum = () =>
  engagementEdited((block) => {
    Object.assign(unchecked<object>(block.objectType.propertyTypes['invoiceCount']), {
      type: { type: 'decimal', decimal: { precision: 14, scale: 2 } },
    });

    const derived = unchecked<{
      derived: { definition: { aggregatedProperties: { propertyTypeMapping: Record<string, unknown> } } };
    }>(block.datasources.find(({ datasource }) => datasource.type === 'derived')?.datasource);

    derived.derived.definition.aggregatedProperties.propertyTypeMapping['invoiceCount'] = {
      type: 'sum',
      sum: { type: 'propertyType', propertyType: 'total' },
    };
  });

const invoiceCountStored = () =>
  engagementEdited((block) => {
    Object.assign(unchecked<object>(block.objectType.propertyTypes['invoiceCount']), {
      status: { type: 'experimental', experimental: {} },
    });

    block.datasources = block.datasources.filter(({ datasource }) => datasource.type !== 'derived');

    const dataset = unchecked<{ datasetV2: { propertyMapping: Record<string, unknown> } }>(
      block.datasources[0]?.datasource,
    );

    dataset.datasetV2.propertyMapping['invoiceCount'] = { type: 'column', column: 'invoiceCount' };
  });

describe('the status of a derived Property', () => {
  it('ontology/object-edits/schema-migrations#edge-rules: a derived Property that the IR marks active cannot be deleted', async () => {
    expect((await publish(derivedIr)).status).toBe(200);

    const response = await publish(withoutInvoiceCount());

    expect(response.status).toBe(400);

    expect(await response.json()).toMatchObject({
      errorName: 'Default:InvalidArgument',
      parameters: {
        change: `Delete Property invoiceCount of Object Type ${ENGAGEMENT}`,
        status: 'active',
        requiredStatus: 'deprecated',
      },
    });
  });

  it('ontology/object-edits/schema-migrations#edge-rules: the base type of a derived Property that the IR marks active cannot change', async () => {
    expect((await publish(derivedIr)).status).toBe(200);

    const response = await publish(invoiceCountAsSum());

    expect(response.status).toBe(400);

    expect(await response.json()).toMatchObject({
      errorName: 'Default:InvalidArgument',
      parameters: {
        change: `Change the base type of Property invoiceCount of Object Type ${ENGAGEMENT}`,
        status: 'active',
        requiredStatus: 'deprecated',
      },
    });
  });

  it.each(['experimental', 'deprecated'] as const)(
    'ontology/object-edits/schema-migrations#edge-rules: a derived Property that the IR marks %s can be deleted',
    async (status) => {
      expect((await publish(invoiceCountWith(status))).status).toBe(200);

      expect((await publish(withoutInvoiceCount())).status).toBe(200);
    },
  );

  it('ontology/object-edits/schema-migrations#edge-rules: the base type of a deprecated derived Property can change', async () => {
    expect((await publish(invoiceCountWith('deprecated'))).status).toBe(200);

    expect((await publish(invoiceCountAsSum())).status).toBe(200);
  });

  it('ontology/object-edits/schema-migrations#edge-rules: a new definition of an active derived Property with the same result type publishes', async () => {
    expect((await publish(derivedIr)).status).toBe(200);

    const recount = engagementEdited((block) => {
      const derived = unchecked<{
        derived: { definition: { aggregatedProperties: { propertyTypeMapping: Record<string, unknown> } } };
      }>(block.datasources.find(({ datasource }) => datasource.type === 'derived')?.datasource);

      derived.derived.definition.aggregatedProperties.propertyTypeMapping['invoiceCount'] = {
        type: 'approximateCardinality',
        approximateCardinality: { type: 'propertyType', propertyType: 'invoiceId' },
      };
    });

    expect((await publish(recount)).status).toBe(200);
  });
});

describe('deleted API names', () => {
  it('ontology/object-edits/schema-migrations#edge-rules: a later publish cannot use the API name of a Property that an earlier publish deleted', async () => {
    expect((await publish(irOf(accountWithNotes('experimental')))).status).toBe(200);

    expect((await publish(irOf(twinObjectType('Account')))).status).toBe(200);

    const response = await publish(irOf(accountWithNotes('experimental')));

    expect(response.status).toBe(400);

    expect(await response.json()).toMatchObject({
      parameters: {
        change: 'Create Property notes of Object Type com.example.twin.Account',
        reservedApiName: 'notes',
        deletedInVersion: 2,
      },
    });
  });

  const reserved = {
    change: `Create Property invoiceCount of Object Type ${ENGAGEMENT}`,
    reservedApiName: 'invoiceCount',
    deletedInVersion: 2,
  };

  it('ontology/object-edits/schema-migrations#edge-rules: a later publish cannot use the API name of a derived Property that an earlier publish deleted', async () => {
    expect((await publish(invoiceCountWith('experimental'))).status).toBe(200);

    expect((await publish(withoutInvoiceCount())).status).toBe(200);

    const response = await publish(invoiceCountWith('experimental'));

    expect(response.status).toBe(400);

    expect(await response.json()).toMatchObject({ parameters: reserved });
  });

  it('ontology/object-edits/schema-migrations#edge-rules: a later publish cannot add the API name of a deleted stored Property as a derived Property', async () => {
    expect((await publish(invoiceCountStored())).status).toBe(200);

    expect((await publish(withoutInvoiceCount())).status).toBe(200);

    const response = await publish(invoiceCountWith('experimental'));

    expect(response.status).toBe(400);

    expect(await response.json()).toMatchObject({ parameters: reserved });
  });

  it('ontology/object-edits/schema-migrations#edge-rules: a later publish cannot add the API name of a deleted derived Property as a stored Property', async () => {
    expect((await publish(invoiceCountWith('experimental'))).status).toBe(200);

    expect((await publish(withoutInvoiceCount())).status).toBe(200);

    const response = await publish(invoiceCountStored());

    expect(response.status).toBe(400);

    expect(await response.json()).toMatchObject({ parameters: reserved });
  });

  it('ontology/object-edits/schema-migrations#edge-rules: a later publish cannot use the API name of a Link Type that an earlier publish deleted', async () => {
    expect((await publish(linkedIr('experimental'))).status).toBe(200);

    expect((await publish(irOf(twinObjectType('Account'), twinObjectType('Engagement')))).status).toBe(200);

    const response = await publish(linkedIr('experimental'));

    expect(response.status).toBe(400);

    expect(await response.json()).toMatchObject({
      parameters: {
        change: 'Create Link Type accountToEngagements',
        reservedApiName: 'accountToEngagements',
        deletedInVersion: 2,
      },
    });
  });

  it('ontology/object-edits/schema-migrations#edge-rules: a kept version that the compiler refuses does not stop a publish, and its deleted names stay reserved', async () => {
    expect((await publish(irOf(accountWithNotes('experimental')))).status).toBe(200);

    expect((await publish(irOf(twinObjectType('Account')))).status).toBe(200);

    const [row] = await database.db.query<
      StoredOntologyVersion & { ir: OntologyIr; osdk_set: StoredOntologyVersion['osdkSet'] }
    >(sql('SELECT version, ir, metadata, osdk_set FROM ontology_registry.product_versions WHERE version = 1'));

    if (!row) throw new Error('Version 1 is not stored.');

    const account = row.ir.ontology.objectTypes[ACCOUNT];

    if (!account) throw new Error('Version 1 has no Account.');

    account.objectType.implementsInterfaces2 = unchecked([
      {
        interfaceTypeApiName: 'com.example.twin.Named',
        actionTypes: {},
        linksV2: {},
        properties: {},
        propertiesV2: {},
      },
    ]);

    await database.db.query(
      sql('UPDATE ontology_registry.product_versions SET ir = $1::jsonb WHERE version = 1', JSON.stringify(row.ir)),
    );

    expect(() => compileOrThrow({ version: 1, ir: row.ir, metadata: row.metadata, osdkSet: row.osdk_set })).toThrow(
      /Interface/,
    );

    const response = await publish(irOf(twinObjectType('Account'), twinObjectType('Engagement')));

    expect(response.status).toBe(200);

    expect(await response.json()).toMatchObject({ version: 3 });

    const reused = await publish(irOf(accountWithNotes('experimental'), twinObjectType('Engagement')));

    expect(reused.status).toBe(400);

    expect(await reused.json()).toMatchObject({
      parameters: {
        change: 'Create Property notes of Object Type com.example.twin.Account',
        reservedApiName: 'notes',
        deletedInVersion: 2,
      },
    });
  });
});
