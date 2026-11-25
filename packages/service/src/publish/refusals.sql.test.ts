import pg from 'pg';
import type {
  OntologyIr,
  OntologyIrActionTypeBlockDataV2,
  OntologyIrLinkTypeBlockDataV2,
  OntologyIrObjectTypeBlockDataV2,
  OntologyIrPropertyType,
} from '@osdk/client.unstable';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { HandleInput } from '../handler/index.ts';
import type { PublishedFunctions, SchemaMigration, WorkosPort } from './index.ts';
import {
  accountWith,
  grantsOf,
  irOf,
  NS,
  propertyOfType,
  stringProperty,
  twinBlock,
  twinFunctions,
  twinIr,
  twinObjectType,
  unchecked,
} from '../ontology/stored.test-utils.ts';
import { personOf } from '../people.test-utils.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { buffered, routeSpans } from '../routeHarness.test-utils.ts';
import { errorAnswer, testSettings } from '../service.test-utils.ts';
import { createTestIssuer, ORGANIZATION, type TestIssuer } from '../tokens.test-utils.ts';
import {
  failingStream,
  failingWith,
  stubPublish,
  stubUsers,
  stubWorkos,
  STUB_PERSON,
  STUB_WORKOS_KEY,
} from '../workos.test-utils.ts';
import { outsideFailure } from '../errors/index.ts';
import { LISTED_SET } from './releasesSupport.test-utils.ts';
import { dropSchema, newDatabase, restoreSwitch, sql, type TestDatabase } from './publish.test-utils.ts';
import { workosPublish } from '../auth/index.ts';
import { main as remapMain } from './remapEntry.ts';
import { fallibleOf } from '../db/promise.test-utils.ts';

const PUBLISH = '/api/ontology-service/v1/publish';
const INSTALL = '/api/ontology-service/v1/ontologies';
const ACCOUNT = `${NS}Account`;
const OTHER_RID = 'ri.ontology.main.ontology.00000000-0000-4000-8000-0000000000e1';

let postgres: TestPostgres;
let issuer: TestIssuer;
let database: TestDatabase;
let consoleLog: MockInstance<typeof console.log>;

beforeAll(async () => {
  postgres = await startPostgres();

  issuer = await createTestIssuer(testSettings.auth);
}, 120_000);

afterAll(() => postgres?.stop());

beforeEach(async () => {
  database = await newDatabase(postgres.url);

  consoleLog = vi.spyOn(console, 'log');
});

afterEach(async () => {
  consoleLog.mockRestore();

  await database.end();
});

type Caller = 'publish' | 'check' | 'person' | 'admin';

interface Options {
  readonly caller?: Caller;
  readonly db?: TestDatabase['db'];
  readonly directDb?: TestDatabase['db'];
  readonly workos?: WorkosPort;
  readonly productRid?: string;
  readonly faults?: unknown[];
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

async function answerOf(response: Response): Promise<unknown> {
  const text = await response.text();

  const parsed = text === '' ? null : (JSON.parse(text) as unknown);
  const headers = Object.fromEntries(response.headers);
  const parameters = (parsed as { parameters?: Record<string, unknown> } | null)?.parameters;

  if (parameters && 'transactionMs' in parameters) parameters['transactionMs'] = '<ms>';

  if (response.status < 400) return { status: response.status, headers, body: parsed === null ? null : 'answered' };

  const answer = { ...errorAnswer({ status: response.status, body: parsed }), headers };

  return JSON.parse(JSON.stringify(answer).replace(UUID, '<uuid>')) as unknown;
}

async function instance(): Promise<(path: string, body: unknown, options?: Options) => Promise<Response>> {
  vi.resetModules();

  const { handle } = await import('../handler/index.ts');

  const users = stubUsers(
    [STUB_PERSON, { ...STUB_PERSON, id: personOf('admin'), email: 'admin@example.com' }],
    [
      { user_id: personOf('admin'), organization_id: ORGANIZATION, status: 'active', roles: ['admin'] },
      { user_id: STUB_PERSON.id, organization_id: ORGANIZATION, status: 'active', roles: ['member'] },
    ],
    { roles: { [ORGANIZATION]: { admin: ['ontology:install'], member: [] } } },
  );

  return async (path, body, options = {}) => {
    const settings =
      options.productRid === undefined ? testSettings : { ...testSettings, productRid: options.productRid };

    const input: HandleInput = {
      db: fallibleOf(options.db ?? database.db),
      directDb: fallibleOf(options.directDb ?? database.db),
      settings,
      keys: issuer.keys,
      users,
      workos: options.workos ?? stubPublish(),
      ...(options.faults ? { reportFault: (error) => options.faults?.push(error) } : {}),
    };

    const caller = options.caller ?? 'publish';

    const token =
      caller === 'publish'
        ? await issuer.github()
        : caller === 'check'
          ? await issuer.github({ environment: undefined, sub: 'repo:example/test-app:pull_request' })
          : await issuer.workos({ sub: caller === 'admin' ? personOf('admin') : STUB_PERSON.id });

    const request = new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

    return buffered(handle(request, input));
  };
}

type Send = Awaited<ReturnType<typeof instance>>;

interface Part {
  readonly validateOnly?: boolean;
  readonly migrations?: readonly SchemaMigration[];
  readonly functions?: PublishedFunctions;
  readonly roles?: readonly string[];
}

function bodyOf(ir: OntologyIr, part: Part = {}): Record<string, unknown> {
  const { validateOnly = false, migrations = [], functions, roles } = part;

  return {
    ir,
    product: 'twin',
    schemaMigrations: { migrations },
    osdkSet: LISTED_SET,
    grants: grantsOf(ir, roles),
    validateOnly,
    ...(functions ? { functions } : {}),
  };
}

const ACCOUNT_IR = irOf(twinObjectType('Account'));

const publishIr = (send: Send, ir: OntologyIr, part: Part = {}, options?: Options) =>
  send(PUBLISH, bodyOf(ir, part), options);

async function applied(send: Send, ir: OntologyIr = ACCOUNT_IR, part: Part = {}): Promise<void> {
  expect((await publishIr(send, ir, part)).status).toBe(200);

  const installed = await send(INSTALL, { product: 'twin', apiName: 'twin', displayName: 'Twin' }, { caller: 'admin' });

  expect(installed.status).toBe(200);
}

async function change(before: OntologyIr, after: OntologyIr, part: Part = {}, first: Part = {}): Promise<unknown> {
  const send = await instance();

  await applied(send, before, first);

  return answerOf(await publishIr(send, after, part));
}

async function insertRow(table: string, values: Record<string, unknown>): Promise<void> {
  const required = await database.db.query<{ column_name: string }>(
    sql(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'ontology_1_objects' AND table_name = $1 AND is_nullable = 'NO' AND column_default IS NULL`,
      table,
    ),
  );

  const all: Record<string, unknown> = {
    ...Object.fromEntries(required.map((row) => [row.column_name, 'x'])),
    ...values,
  };

  const names = Object.keys(all);

  await database.db.query(
    sql(
      `INSERT INTO ontology_1_objects.${table} (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
      ...Object.values(all),
    ),
  );
}

async function changeWithObject(
  before: OntologyIr,
  after: OntologyIr,
  values: Record<string, unknown>,
  part: Part = {},
): Promise<unknown> {
  const send = await instance();

  await applied(send, before);

  await insertRow('account', values);

  return answerOf(await publishIr(send, after, part));
}

const without = (body: Record<string, unknown>, ...keys: string[]) =>
  Object.fromEntries(Object.entries(body).filter(([key]) => !keys.includes(key)));

interface Case {
  readonly name: string;
  readonly run: () => Promise<unknown>;
}

const recorded = (name: string, run: () => Promise<unknown>): Case => ({ name, run });

function pin(cases: readonly Case[]): void {
  for (const { name, run } of cases) {
    it(name, async () => {
      expect(await run()).toMatchSnapshot();
    });
  }
}

const requested = (mutate: (body: Record<string, unknown>) => unknown, options?: Options) => async () => {
  const send = await instance();

  return answerOf(await send(PUBLISH, mutate(bodyOf(ACCOUNT_IR)), options));
};

describe('publish: the request body', () => {
  const base = () => bodyOf(ACCOUNT_IR);

  pin([
    recorded(
      'a body that is not an object',
      requested(() => []),
    ),
    recorded(
      'no product',
      requested((body) => without(body, 'product')),
    ),
    recorded(
      'an empty product',
      requested((body) => ({ ...body, product: '' })),
    ),
    recorded(
      'no IR',
      requested((body) => without(body, 'ir')),
    ),
    recorded(
      'an IR with no Object Types',
      requested((body) => ({ ...body, ir: { ontology: { actionTypes: {} } } })),
    ),
    recorded(
      'no schema migrations',
      requested((body) => without(body, 'schemaMigrations')),
    ),
    recorded(
      'schema migrations that are not a list',
      requested((body) => ({ ...body, schemaMigrations: { migrations: {} } })),
    ),
    recorded(
      'a schema migration that is not an object',
      requested((body) => ({ ...body, schemaMigrations: { migrations: [1] } })),
    ),
    recorded(
      'a schema migration with no type',
      requested((body) => ({ ...body, schemaMigrations: { migrations: [{}] } })),
    ),
    recorded(
      'a schema migration with no field',
      requested((body) => ({
        ...base(),
        ...body,
        schemaMigrations: { migrations: [{ type: 'dropProperty', objectType: ACCOUNT }] },
      })),
    ),
    recorded(
      'a schema migration outside V1',
      requested((body) => ({ ...body, schemaMigrations: { migrations: [{ type: 'cast' }] } })),
    ),
    recorded(
      'an unknown schema migration',
      requested((body) => ({ ...body, schemaMigrations: { migrations: [{ type: 'frobnicate' }] } })),
    ),
    recorded(
      'no OSDK set',
      requested((body) => without(body, 'osdkSet')),
    ),
    recorded(
      'an OSDK set with a version that is not a string',
      requested((body) => ({ ...body, osdkSet: { '@osdk/client': 1 } })),
    ),
    recorded(
      'an OSDK set that no release lists',
      requested((body) => ({ ...body, osdkSet: { '@osdk/client': '0.0.1' } })),
    ),
    recorded(
      'no grants',
      requested((body) => without(body, 'grants')),
    ),
    recorded(
      'a grants file of v2',
      requested((body) => ({ ...body, grants: { version: 2 } })),
    ),
    recorded(
      'grants that name an unknown Object Type',
      requested((body) => ({ ...body, grants: { ...grantsOf(ACCOUNT_IR), objectTypes: { Unknown: 'twin:use' } } })),
    ),
    recorded(
      'no validateOnly',
      requested((body) => without(body, 'validateOnly')),
    ),
    recorded(
      'Functions that are not an object',
      requested((body) => ({ ...body, functions: 1 })),
    ),
    recorded(
      'Functions with no bundle',
      requested((body) => ({ ...body, functions: { discovered: [] } })),
    ),
    recorded(
      'Functions with no discovered list',
      requested((body) => ({ ...body, functions: { bundle: '' } })),
    ),
    recorded(
      'a discovered Function with no locator',
      requested((body) => ({ ...body, functions: { bundle: '', discovered: [{}] } })),
    ),
    recorded(
      'an IR with an Interface',
      requested((body) => ({
        ...body,
        ir: { ...ACCOUNT_IR, ontology: { ...ACCOUNT_IR.ontology, interfaceTypes: { [`${NS}Asset`]: {} } } },
      })),
    ),
    recorded('a caller that is a person', requested(base, { caller: 'person' })),
  ]);
});

describe('publish: the stored versions', () => {
  pin([
    recorded('another product than the stored one', async () => {
      const send = await instance();

      await publishIr(send, ACCOUNT_IR);

      return answerOf(await send(PUBLISH, { ...bodyOf(ACCOUNT_IR), product: 'other' }));
    }),
    recorded('another Ontology RID than the stored one', async () => {
      const send = await instance();

      await publishIr(send, ACCOUNT_IR);

      return answerOf(await publishIr(send, ACCOUNT_IR, {}, { productRid: OTHER_RID }));
    }),
    recorded('a name that an earlier version deleted', async () => {
      const send = await instance();

      const engagement = () => {
        const block = twinObjectType('Engagement');

        block.objectType.status = unchecked({ type: 'experimental', experimental: {} });

        return block;
      };

      expect((await publishIr(send, irOf(twinObjectType('Account'), engagement()))).status).toBe(200);

      expect((await publishIr(send, ACCOUNT_IR)).status).toBe(200);

      return answerOf(await publishIr(send, irOf(twinObjectType('Account'), engagement())));
    }),
    recorded('a table with more than 1,600 columns', async () => {
      const wide = (prefix: string) => {
        const block = twinObjectType('Account');

        for (let index = 0; index < 1_000; index++)
          block.objectType.propertyTypes[`${prefix}${index}`] = {
            ...stringProperty(`${prefix}${index}`),
            status: unchecked({ type: 'experimental', experimental: {} }),
          };

        return irOf(block);
      };

      return change(wide('a'), wide('b'));
    }),
    recorded('2 Object Types with 1 table name', async () => {
      const first = twinObjectType('Account');
      const second = twinObjectType('Account');

      second.objectType.apiName = `${NS}ACCOUNT`;

      return answerOf(await publishIr(await instance(), irOf(first, second)));
    }),
    recorded('2 Properties with 1 column name', async () => {
      const block = accountWith(stringProperty('customerID'));

      block.objectType.propertyTypes['customerId'] = stringProperty('customerId');

      return answerOf(await publishIr(await instance(), irOf(block)));
    }),
    recorded('a Property with a reserved column name', async () => {
      return answerOf(await publishIr(await instance(), irOf(accountWith(stringProperty('ctid')))));
    }),
    recorded('an installation that is not on the newest version', async () => {
      const send = await instance();

      await applied(send);

      await database.db.query(sql('UPDATE ontology_registry.ontologies SET version = 0'));

      return answerOf(await publishIr(send, irOf(accountWith(stringProperty('notes')))));
    }),
    recorded('a version stored while the publish waited for the lock', async () => {
      const send = await instance();

      await publishIr(send, ACCOUNT_IR);

      const base = database.db;

      const racing: TestDatabase['db'] = {
        ...base,
        transaction: async (run) => {
          await base.query(
            sql(`INSERT INTO ontology_registry.product_versions (product, version, ir, metadata, schema_migrations, osdk_set, functions, grants, publisher)
                 SELECT product, 2, ir, metadata, schema_migrations, osdk_set, functions, grants, publisher FROM ontology_registry.product_versions WHERE version = 1`),
          );

          return base.transaction(run);
        },
      };

      return answerOf(await publishIr(send, irOf(accountWith(stringProperty('notes'))), {}, { directDb: racing }));
    }),
  ]);
});

describe('publish: the schema migrations and the edge rules', () => {
  const notes = (
    type: 'string' | 'integer',
    status: 'active' | 'experimental' | 'deprecated' = 'experimental',
  ): OntologyIrObjectTypeBlockDataV2 => {
    const property: OntologyIrPropertyType =
      type === 'string' ? stringProperty('notes') : propertyOfType('notes', { type: 'integer', integer: {} });

    property.status = unchecked(
      status === 'active'
        ? { type: 'active', active: {} }
        : status === 'deprecated'
          ? { type: 'deprecated', deprecated: { message: 'Use the new one.', deadline: '2027-01-01T00:00:00Z' } }
          : { type: 'experimental', experimental: {} },
    );

    return accountWith(property);
  };

  const withNotes = (type: 'string' | 'integer', status?: 'active' | 'experimental' | 'deprecated') =>
    irOf(notes(type, status));

  const KEY = 'account_id';

  pin([
    recorded('an Object Type that is deleted while it is active', () =>
      change(irOf(twinObjectType('Account'), twinObjectType('Engagement')), ACCOUNT_IR),
    ),
    recorded('an Object Type that is deleted with Objects', async () => {
      const send = await instance();

      const engagement = twinObjectType('Engagement');

      engagement.objectType.status = unchecked({ type: 'experimental', experimental: {} });

      await applied(send, irOf(twinObjectType('Account'), engagement));

      await insertRow('engagement', { engagement_id: 'e1' });

      return answerOf(await publishIr(send, ACCOUNT_IR));
    }),
    recorded('a Property that is deleted while it is active', () => change(withNotes('string', 'active'), ACCOUNT_IR)),
    recorded('a Property that is deleted with values', () =>
      changeWithObject(withNotes('string'), ACCOUNT_IR, { [KEY]: 'a1', notes: 'x' }),
    ),
    recorded('a Property whose base type changes while it is active', () =>
      change(withNotes('string', 'active'), withNotes('integer', 'active')),
    ),
    recorded('a Property whose base type changes with values', () =>
      changeWithObject(withNotes('string'), withNotes('integer'), { [KEY]: 'a1', notes: 'x' }),
    ),
    recorded('a required Property that is new, with Objects', () =>
      changeWithObject(
        ACCOUNT_IR,
        irOf(
          accountWith(
            unchecked({
              ...stringProperty('must'),
              dataConstraints: {
                propertyTypeConstraints: [],
                nullabilityV2: { noNulls: true, noEmptyCollections: false },
              },
            }),
          ),
        ),
        { [KEY]: 'a1' },
      ),
    ),
    recorded('a schema migration that moves the primary key', () => {
      const after = twinObjectType('Account');

      delete after.objectType.propertyTypes['accountId'];

      after.objectType.propertyTypes['code'] = stringProperty('code');

      after.objectType.primaryKeys = ['code'];

      return change(ACCOUNT_IR, irOf(after), {
        migrations: [{ type: 'renameProperty', objectType: ACCOUNT, source: 'accountId', target: 'code' }],
      });
    }),
    recorded('a schema migration that moves 2 Properties to 1 target', () => {
      const experimental = (name: string) => ({
        ...stringProperty(name),
        status: unchecked<OntologyIrPropertyType['status']>({ type: 'experimental', experimental: {} }),
      });

      const before = twinObjectType('Account');

      before.objectType.propertyTypes['a'] = experimental('a');
      before.objectType.propertyTypes['b'] = experimental('b');

      return change(irOf(before), irOf(accountWith(stringProperty('c'))), {
        migrations: [
          { type: 'renameProperty', objectType: ACCOUNT, source: 'a', target: 'c' },
          { type: 'renameProperty', objectType: ACCOUNT, source: 'b', target: 'c' },
        ],
      });
    }),
    recorded('a struct field that is deleted with values', async () => {
      const probe = `${NS}StructProbe`;
      const before = twinBlock('0.6.3', probe);
      const after = structuredClone(before);
      const type = after.objectType.propertyTypes['measures']?.type;

      if (type?.type !== 'struct') throw new Error('The twin StructProbe has no struct Property.');

      type.struct.structFields = type.struct.structFields.filter((field) => field.apiName !== 'flag');

      const send = await instance();

      await applied(send, irOf(before));

      await insertRow('struct_probe', { probe_id: 'p1', measures: JSON.stringify({ flag: true }) });

      return answerOf(await publishIr(send, irOf(after)));
    }),
    recorded('a schema migration that moves an active Property', () =>
      change(withNotes('string', 'active'), irOf(accountWith(stringProperty('renamed'))), {
        migrations: [{ type: 'renameProperty', objectType: ACCOUNT, source: 'notes', target: 'renamed' }],
      }),
    ),
    recorded('a primary key change with Objects', async () => {
      const after = twinObjectType('Account');

      after.objectType.primaryKeys = ['name'];

      return changeWithObject(ACCOUNT_IR, irOf(after), { [KEY]: 'a1', name: 'n' });
    }),
    recorded('a Link Type that is deleted while it is active', async () => {
      const link = twinIr('0.4.0').ontology.linkTypes['account-to-engagements'];
      const before = irOf(twinObjectType('Account'), twinObjectType('Engagement'));

      return change(
        {
          ...before,
          ontology: { ...before.ontology, linkTypes: { 'account-to-engagements': structuredClone(link) as never } },
        },
        irOf(twinObjectType('Account'), twinObjectType('Engagement')),
      );
    }),
    recorded('an Action Type that is deleted while it is active', async () => {
      const ir = twinIr('0.4.0');

      return change(
        ir,
        { ...ir, ontology: { ...ir.ontology, actionTypes: {} } },
        { validateOnly: true },
        { functions: twinFunctions('0.4.0') },
      );
    }),
  ]);
});

const CREATE_ACCOUNT = `${NS}create-account`;

function accountActionIr(notes: 'none' | 'optional' | 'required'): OntologyIr {
  const block = structuredClone(
    twinIr('0.4.0').ontology.actionTypes[CREATE_ACCOUNT],
  ) as OntologyIrActionTypeBlockDataV2;

  const { metadata, actionTypeLogic } = block.actionType;

  metadata.status = unchecked({ type: 'active', active: {} });

  if (notes !== 'none') {
    metadata.parameters['notes'] = unchecked({
      id: 'notes',
      type: { type: 'string', string: {} },
      displayMetadata: { displayName: 'notes', description: '', typeClasses: [] },
    });

    actionTypeLogic.validation.parameterValidations['notes'] = unchecked({
      defaultValidation: {
        display: { renderHint: { type: 'textInput', textInput: {} }, visibility: { type: 'editable', editable: {} } },
        validation: {
          allowedValues: { type: 'text', text: { type: 'text', text: {} } },
          required:
            notes === 'required' ? { type: 'required', required: {} } : { type: 'notRequired', notRequired: {} },
        },
      },
      conditionalOverrides: [],
    });
  }

  const ir = irOf(twinObjectType('Account'));

  return { ...ir, ontology: { ...ir.ontology, actionTypes: { [CREATE_ACCOUNT]: block } } };
}

function linkedIr(side: string): OntologyIr {
  const block = structuredClone(
    twinIr('0.4.0').ontology.linkTypes['account-to-engagements'],
  ) as OntologyIrLinkTypeBlockDataV2;

  block.linkType.status = unchecked({ type: 'active', active: {} });

  if (block.linkType.definition.type !== 'oneToMany') throw new Error('The twin Link Type is not one-to-many.');

  block.linkType.definition.oneToMany.oneToManyLinkMetadata.apiName = side;

  const ir = irOf(twinObjectType('Account'), twinObjectType('Engagement'));

  return { ...ir, ontology: { ...ir.ontology, linkTypes: { 'account-to-engagements': block } } };
}

describe('publish: the Action Types and the Link Types', () => {
  pin([
    recorded('an Action Type that gets a required parameter while it is active', () =>
      change(accountActionIr('none'), accountActionIr('required')),
    ),
    recorded('an Action Type that loses a parameter while it is active', () =>
      change(accountActionIr('optional'), accountActionIr('none')),
    ),
    recorded('a side of a Link Type that is renamed while it is active', () =>
      change(linkedIr('engagements'), linkedIr('workOrders')),
    ),
  ]);
});

function faultOf(error: unknown): unknown {
  if (!(error instanceof Error)) return error;

  const { cause } = error;

  return { name: error.name, message: error.message, ...(cause === undefined ? {} : { cause: faultOf(cause) }) };
}

describe('publish: WorkOS', () => {
  const grantsRoles = (roles: readonly string[]) => ({ roles });

  pin([
    recorded('a default role that a member holds is dropped', async () => {
      const stub = stubWorkos(
        [STUB_PERSON],
        [{ user_id: STUB_PERSON.id, organization_id: ORGANIZATION, status: 'active', roles: ['viewer'] }],
      );

      const workos = workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch });

      const send = await instance();

      await publishIr(send, ACCOUNT_IR, grantsRoles(['admin', 'viewer']), { workos });

      return answerOf(await publishIr(send, ACCOUNT_IR, grantsRoles(['admin']), { workos }));
    }),
    recorded('WorkOS fails after the version is stored', async () => {
      const send = await instance();

      const { ApiError } = await import('../errors/index.ts');

      const real = stubPublish();
      let reads = 0;

      const workos: WorkosPort = {
        ...real,
        read: () =>
          ++reads > 1
            ? failingWith(new ApiError(503, 'OntologyService:WorkosUnavailable', {}, { 'retry-after': '10' }))
            : real.read(),
      };

      const answer = await answerOf(await publishIr(send, ACCOUNT_IR, {}, { workos }));

      const versions = await database.db.query(sql('SELECT version FROM ontology_registry.product_versions'));

      return { answer, versions };
    }),
    recorded('the reconcile fails with an error that is not a WorkOS failure', async () => {
      const send = await instance();

      const real = stubPublish();
      let reads = 0;

      const workos: WorkosPort = {
        ...real,
        read: () =>
          ++reads > 1 ? failingWith(outsideFailure(new Error('The test makes the reconcile fail.'))) : real.read(),
      };

      return answerOf(await publishIr(send, ACCOUNT_IR, {}, { workos }));
    }),
    recorded('the store waits for the lock of the registry row, then the reconcile has a defect', async () => {
      const send = await instance();

      await applied(send);

      const other = new pg.Client({ connectionString: database.url });

      await other.connect();

      await other.query('BEGIN');

      await other.query('SELECT 1 FROM ontology_registry.ontologies FOR UPDATE');

      const real = stubPublish();
      let reads = 0;

      const workos: WorkosPort = {
        ...real,
        read: () =>
          ++reads > 1 ? failingWith(outsideFailure(new TypeError('The test makes the reconcile fail.'))) : real.read(),
      };

      const faults: unknown[] = [];

      try {
        const answer = await answerOf(
          await publishIr(send, irOf(accountWith(stringProperty('notes'))), {}, { workos, faults }),
        );

        const versions = await database.db.query(sql('SELECT version FROM ontology_registry.product_versions'));

        return { answer, versions, faults: faults.map(faultOf) };
      } finally {
        await other.query('ROLLBACK').catch(() => undefined);

        await other.end();
      }
    }),
    recorded('the insert of the product version has a defect, then the reconcile has a defect', async () => {
      const send = await instance();

      const base = database.db;

      const failing: TestDatabase['db'] = {
        ...base,
        transaction: (run) =>
          base.transaction((tx) =>
            run({
              ...tx,
              query: (statement) =>
                statement.text.includes('INSERT INTO ontology_registry.product_versions')
                  ? Promise.reject(new TypeError('The test makes the insert fail.'))
                  : tx.query(statement),
            }),
          ),
      };

      const real = stubPublish();
      let reads = 0;

      const workos: WorkosPort = {
        ...real,
        read: () =>
          ++reads > 1 ? failingWith(outsideFailure(new TypeError('The test makes the reconcile fail.'))) : real.read(),
      };

      const faults: unknown[] = [];

      const answer = await answerOf(await publishIr(send, ACCOUNT_IR, {}, { directDb: failing, workos, faults }));

      const versions = await database.db.query(sql('SELECT version FROM ontology_registry.product_versions'));

      return { answer, versions, faults: faults.map(faultOf) };
    }),
    recorded('WorkOS fails before the version is stored', async () => {
      const send = await instance();

      const { ApiError } = await import('../errors/index.ts');

      const real = stubPublish();

      const workos: WorkosPort = {
        ...real,
        apply: () => failingWith(new ApiError(503, 'OntologyService:WorkosUnavailable', {}, { 'retry-after': '10' })),
      };

      const answer = await answerOf(await publishIr(send, ACCOUNT_IR, {}, { workos }));

      const versions = await database.db.query(sql('SELECT version FROM ontology_registry.product_versions'));

      return { answer, versions };
    }),
  ]);
});

describe('publish: faults', () => {
  const failure = (name: string) => outsideFailure(new TypeError(`The test makes ${name} fail.`));

  async function faulted(
    workos: WorkosPort | undefined,
    ir: OntologyIr = ACCOUNT_IR,
    directDb?: TestDatabase['db'],
    before?: (send: Send) => Promise<void>,
  ): Promise<unknown> {
    const send = await instance();

    await before?.(send);

    const faults: unknown[] = [];

    const answer = await answerOf(
      await publishIr(send, ir, {}, { ...(workos ? { workos } : {}), ...(directDb ? { directDb } : {}), faults }),
    );

    const versions = await database.db.query(sql('SELECT version FROM ontology_registry.product_versions'));

    return { answer, versions, faults: faults.map(faultOf) };
  }

  pin([
    recorded('the apply of a WorkOS step has a defect', () =>
      faulted({ ...stubPublish(), apply: () => failingWith(failure('the apply')) }),
    ),
    recorded('the read of WorkOS before the store has a defect', () =>
      faulted({ ...stubPublish(), read: () => failingWith(failure('the read')) }),
    ),
    recorded('the member roles of WorkOS have a defect', async () => {
      const stub = stubPublish();
      const memberRoles: WorkosPort['memberRoles'] = () => failingStream(failure('the member roles'));

      const send = await instance();

      await publishIr(send, ACCOUNT_IR, { roles: ['admin', 'viewer'] }, { workos: stub });

      const faults: unknown[] = [];

      const answer = await answerOf(
        await publishIr(send, ACCOUNT_IR, { roles: ['admin'] }, { workos: { ...stub, memberRoles }, faults }),
      );

      return { answer, faults: faults.map(faultOf) };
    }),
    recorded('the check of an installation has a defect', async () => {
      const base = database.db;

      const failing: TestDatabase['db'] = {
        ...base,
        query: (statement) =>
          statement.text.includes('FROM pg_attribute a JOIN pg_class c') && statement.values[0] === 'ontology_1_objects'
            ? Promise.reject(new TypeError('The test makes the check fail.'))
            : base.query(statement),
      };

      return faulted(undefined, irOf(accountWith(stringProperty('notes'))), failing, (send) => applied(send));
    }),
    recorded('the newest stored version does not compile', () =>
      faulted(undefined, irOf(accountWith(stringProperty('notes'))), undefined, async (send) => {
        await applied(send);

        await database.db.query(sql(`UPDATE ontology_registry.product_versions SET ir = '{"ontology": {}}'::jsonb`));
      }),
    ),
  ]);
});

describe('install', () => {
  const install =
    (body: unknown, caller: Caller = 'admin', before?: (send: Send) => Promise<void>) =>
    async () => {
      const send = await instance();

      await before?.(send);

      return answerOf(await send(INSTALL, body, { caller }));
    };

  const valid = { product: 'twin', apiName: 'twin', displayName: 'Twin' };

  pin([
    recorded(
      'a caller with no install permission',
      install(valid, 'person', (send) => publishIr(send, ACCOUNT_IR).then(() => undefined)),
    ),
    recorded('no product', install({ ...valid, product: undefined })),
    recorded('no API name', install({ ...valid, apiName: undefined })),
    recorded('an API name with a capital', install({ ...valid, apiName: 'Twin' })),
    recorded('no display name', install({ ...valid, displayName: '' })),
    recorded('a product that is not stored', install(valid)),
    recorded(
      'an API name that the Organization has',
      install(valid, 'admin', async (send) => {
        await applied(send);
      }),
    ),
  ]);
});

const SQL_SPANS = new Set(['sql', 'sql connection wait']);

async function traceOf(path: string): Promise<unknown> {
  const spans = await routeSpans();

  const root = spans.filter((span) => span.parentSpanId === undefined && span.name === `POST ${path}`).at(-1);

  const trace = spans
    .filter((span) => span.traceId === root?.traceId && (!SQL_SPANS.has(span.name) || span.status.code !== 0))
    .sort((a, b) => (a.start === b.start ? a.name.localeCompare(b.name) : a.start < b.start ? -1 : 1));

  const names = new Map(spans.map((span) => [span.spanId, span.name]));
  const scrubbed = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replace(UUID, '<uuid>')) as unknown;

  return scrubbed(
    trace.map((span) => ({
      name: span.name,
      parent: span.parentSpanId === undefined ? null : names.get(span.parentSpanId),
      status: span.status,
      attributes: span.attributes,
    })),
  );
}

describe('publish and install: the registry has no product versions table', () => {
  const faulted = (path: string, body: (send: Send) => unknown, caller: Caller) => async () => {
    const send = await instance();

    await applied(send);

    await database.db.query(sql('DROP TABLE ontology_registry.product_versions CASCADE'));

    const faults: unknown[] = [];

    const answer = await answerOf(await send(path, body(send), { caller, faults }));

    return { answer, faults: faults.map(faultOf), spans: await traceOf(path) };
  };

  pin([
    recorded(
      'a publish',
      faulted(PUBLISH, () => bodyOf(ACCOUNT_IR), 'publish'),
    ),
    recorded(
      'an install',
      faulted(INSTALL, () => ({ product: 'twin', apiName: 'twin', displayName: 'Twin' }), 'admin'),
    ),
  ]);
});

async function portOf(fetch: typeof globalThis.fetch): Promise<WorkosPort> {
  const { workosPublish: fresh } = await import('../auth/index.ts');

  return fresh(STUB_WORKOS_KEY, { fetch });
}

function failingPort(read: 'permissions' | 'write'): Promise<WorkosPort> {
  const stub = stubWorkos();

  stub.fail('5xx', { reads: [read] });

  return portOf(stub.fetch);
}

function reconcileFailingPort(): Promise<WorkosPort> {
  const stub = stubWorkos();
  let reads = 0;

  const urlOf = (input: Parameters<typeof globalThis.fetch>[0]): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  return portOf((input, init) =>
    new URL(urlOf(input)).pathname === '/authorization/permissions' && ++reads > 1
      ? Promise.resolve(Response.json({}, { status: 500 }))
      : stub.fetch(input, init),
  );
}

describe('publish and install: the spans', () => {
  const traced = (path: string, run: (send: Send) => Promise<Response>) => async () => {
    const send = await instance();

    await send(INSTALL, {}, { caller: 'person' });

    const answer = await answerOf(await run(send));

    return { answer, spans: await traceOf(path) };
  };

  const valid = { product: 'twin', apiName: 'twin', displayName: 'Twin' };

  pin([
    recorded(
      'an applied publish',
      traced(PUBLISH, (send) => publishIr(send, ACCOUNT_IR)),
    ),
    recorded(
      'a validateOnly publish',
      traced(PUBLISH, (send) => publishIr(send, ACCOUNT_IR, { validateOnly: true }, { caller: 'check' })),
    ),
    recorded(
      'a publish of no body',
      traced(PUBLISH, (send) => send(PUBLISH, {})),
    ),
    recorded(
      'a publish of a grants file with a problem',
      traced(PUBLISH, (send) =>
        send(PUBLISH, {
          ...bodyOf(ACCOUNT_IR),
          grants: { ...grantsOf(ACCOUNT_IR), objectTypes: { Unknown: 'twin:use' } },
        }),
      ),
    ),
    recorded(
      'a validateOnly publish of a change to an installed Object Type',
      traced(PUBLISH, async (send) => {
        await applied(send);

        return publishIr(send, irOf(accountWith(stringProperty('notes'))), { validateOnly: true }, { caller: 'check' });
      }),
    ),
    recorded(
      'a publish that an installed Ontology refuses',
      traced(PUBLISH, async (send) => {
        await applied(send, accountActionIr('none'));

        return publishIr(send, accountActionIr('required'));
      }),
    ),
    recorded(
      'a publish with a WorkOS step that has a defect',
      traced(PUBLISH, (send) =>
        publishIr(
          send,
          ACCOUNT_IR,
          {},
          {
            workos: {
              ...stubPublish(),
              apply: () => failingWith(outsideFailure(new TypeError('The test makes the apply fail.'))),
            },
          },
        ),
      ),
    ),
    recorded(
      'a publish whose WorkOS permission read fails',
      traced(PUBLISH, async (send) => publishIr(send, ACCOUNT_IR, {}, { workos: await failingPort('permissions') })),
    ),
    recorded(
      'a publish whose WorkOS write fails',
      traced(PUBLISH, async (send) => publishIr(send, ACCOUNT_IR, {}, { workos: await failingPort('write') })),
    ),
    recorded(
      'a publish whose RoleInUse check cannot read the Organizations',
      traced(PUBLISH, async (send) => {
        const stub = stubWorkos(
          [STUB_PERSON],
          [{ user_id: STUB_PERSON.id, organization_id: ORGANIZATION, status: 'active', roles: ['viewer'] }],
        );

        const workos = await portOf(stub.fetch);

        await publishIr(send, ACCOUNT_IR, { roles: ['admin', 'viewer'] }, { workos });

        stub.fail('5xx', { reads: ['organizations'] });

        return publishIr(send, ACCOUNT_IR, { roles: ['admin'] }, { workos });
      }),
    ),
    recorded(
      'a publish whose RoleInUse check finds a member of a dropped role',
      traced(PUBLISH, async (send) => {
        const stub = stubWorkos(
          [STUB_PERSON],
          [{ user_id: STUB_PERSON.id, organization_id: ORGANIZATION, status: 'active', roles: ['viewer'] }],
        );

        const workos = await portOf(stub.fetch);

        await publishIr(send, ACCOUNT_IR, { roles: ['admin', 'viewer'] }, { workos });

        return publishIr(send, ACCOUNT_IR, { roles: ['admin'] }, { workos });
      }),
    ),
    recorded(
      'a publish whose reconcile cannot read WorkOS',
      traced(PUBLISH, async (send) => publishIr(send, ACCOUNT_IR, {}, { workos: await reconcileFailingPort() })),
    ),
    recorded(
      'an install',
      traced(INSTALL, async (send) => {
        await publishIr(send, ACCOUNT_IR);

        return send(INSTALL, valid, { caller: 'admin' });
      }),
    ),
    recorded(
      'an install that the product refuses',
      traced(INSTALL, (send) => send(INSTALL, valid, { caller: 'admin' })),
    ),
    recorded(
      'an install of a caller with no permission',
      traced(INSTALL, (send) => send(INSTALL, valid, { caller: 'person' })),
    ),
  ]);
});

async function outcomeOf(run: () => Promise<unknown>): Promise<unknown> {
  const ran = await run().then(
    (value) => ({ gave: value }),
    (error: unknown) => ({
      rejected: {
        name: (error as Error).name,
        code: (error as { code?: unknown }).code,
        message: (error as Error).message,
      },
    }),
  );

  return JSON.parse(JSON.stringify(ran)) as unknown;
}

const SWITCH = {
  schemas: { object: 'ontology_9_objects_20260101000000', engine: 'ontology_9_engine_20260101000000' },
  source: { number: 1, version: 1, engineChangeCount: 0 },
} as const;

const UNKNOWN_RID = 'ri.ontology.main.ontology.00000000-0000-4000-8000-0000000000ff';

describe('restore', () => {
  pin([
    recorded('a switch of an installation that production lacks', async () => {
      await applied(await instance());

      return outcomeOf(() => restoreSwitch(database.db, { rid: UNKNOWN_RID, ...SWITCH }));
    }),
    recorded('a switch with a lock wait that Postgres refuses', async () => {
      await applied(await instance());

      return outcomeOf(() => restoreSwitch(database.db, { rid: UNKNOWN_RID, ...SWITCH, lockTimeout: 'bogus' }));
    }),
    recorded('a switch whose lock wait ends, for an installation that production lacks', async () => {
      await applied(await instance());

      const holder = new pg.Client({ connectionString: database.url });

      await holder.connect();

      try {
        await holder.query('BEGIN');

        await holder.query('LOCK TABLE ontology_registry.ontologies IN EXCLUSIVE MODE');

        return await outcomeOf(() => restoreSwitch(database.db, { rid: UNKNOWN_RID, ...SWITCH, lockTimeout: '200ms' }));
      } finally {
        await holder.end();
      }
    }),
    recorded('a drop with a lock wait that Postgres refuses', async () => {
      await applied(await instance());

      return outcomeOf(() =>
        dropSchema(database.db, { schema: 'ontology_9_objects_20260101000000', write: false, lockTimeout: 'bogus' }),
      );
    }),
    recorded('a drop of a schema with another form', () =>
      outcomeOf(() => dropSchema(database.db, { schema: 'public', write: false })),
    ),
  ]);
});

describe('remap', () => {
  interface Run {
    readonly env?: Record<string, string | undefined>;
    readonly fetch?: typeof fetch;
    readonly lockTimeout?: string;
  }

  const remapped =
    (run: Run = {}) =>
    async () => {
      await applied(await instance());

      const out: string[] = [];
      const err: string[] = [];

      const exitCode = await remapMain({
        env: { DATABASE_URL_DIRECT: database.url, WORKOS_API_KEY: 'key', NEON_BRANCH_ID: 'branch', ...run.env },
        fetch: run.fetch ?? (() => Promise.resolve(new Response('{}', { status: 404 }))),
        stdout: (text) => void out.push(text),
        stderr: (text) => void err.push(text),
        ...(run.lockTimeout === undefined ? {} : { lockTimeout: run.lockTimeout }),
      });

      return { exitCode, stdout: out, stderr: err.join('').replaceAll(database.url, '<url>') };
    };

  pin([
    recorded('a missing variable', remapped({ env: { NEON_BRANCH_ID: undefined } })),
    recorded(
      'WorkOS that cannot be reached',
      remapped({
        fetch: () => Promise.reject(Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } })),
      }),
    ),
    recorded(
      'WorkOS that answers with no Organization ID',
      remapped({ fetch: () => Promise.resolve(new Response('{}', { status: 500 })) }),
    ),
    recorded(
      'a lock wait that Postgres refuses',
      remapped({ fetch: () => Promise.resolve(Response.json({ id: 'org_mirror' })), lockTimeout: 'bogus' }),
    ),
  ]);
});
