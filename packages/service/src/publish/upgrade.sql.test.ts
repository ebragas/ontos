import type { OntologyIr, OntologyIrObjectTypeBlockDataV2 } from '@osdk/client.unstable';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../db/index.ts';
import { createDb, type Db } from '../db/promise.test-utils.ts';
import type { PublishResponse, SchemaMigration } from './index.ts';
import { installOntology } from '../install.test-utils.ts';
import { chainState } from './pure/upgradeErrors.ts';
import { compileOrThrow, convertOrThrow, irOf, NS, policiesIr, twinObjectType } from '../ontology/stored.test-utils.ts';
import { createEngineTemplate, startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { TEST_ONTOLOGY_RID } from '../service.test-utils.ts';
import { ORGANIZATION } from '../tokens.test-utils.ts';
import {
  APPLY,
  expectAllOnNewest,
  lockInstallation,
  NO_GRANTS,
  OSDK_SET,
  planStep,
  PUBLISHER,
  publishOntology,
  readProductVersion,
  runChain,
  waitForLockWaits,
} from './publish.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const PRODUCT = 'twin';
const ONTOLOGIES = 'ontology_registry.ontologies';
const MOVE_PHASE: SchemaMigration = { type: 'renameProperty', objectType: ACCOUNT, source: 'phase', target: 'stage' };
const REQUIRED = { nullabilityV2: { noNulls: true, noEmptyCollections: false }, propertyTypeConstraints: [] };
const SERVICE_PASSWORD = 'upgrade-role-test-only';

let postgres: TestPostgres;
let serviceRole: string;
let template: string;
let databases = 0;
let admin: pg.Client;
let adminUrl: string;
let pool: pg.Pool;
let db: Db;

beforeAll(async () => {
  postgres = await startPostgres();

  serviceRole = `${postgres.role}_service`;

  await onAdmin(
    postgres.url,
    `CREATE ROLE ${serviceRole} LOGIN PASSWORD '${SERVICE_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );

  template = await createEngineTemplate(postgres.url, { name: serviceRole, password: SERVICE_PASSWORD });
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  const name = `${postgres.role}_upgrade_${++databases}`;

  await onAdmin(postgres.url, `CREATE DATABASE ${name} TEMPLATE ${template}`);

  await onAdmin(postgres.url, `GRANT CREATE ON DATABASE ${name} TO ${serviceRole}`);

  const url = new URL(postgres.url);

  url.pathname = `/${name}`;

  adminUrl = url.toString();

  admin = new pg.Client({ connectionString: adminUrl });

  await admin.connect();

  url.username = serviceRole;
  url.password = SERVICE_PASSWORD;

  pool = createPool(url.toString());

  db = createDb(pool);
});

afterEach(async () => {
  await admin.end();

  await pool.end();
});

async function onAdmin(url: string, text: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });

  await client.connect();

  try {
    await client.query(text);
  } finally {
    await client.end();
  }
}

function account(change: (block: OntologyIrObjectTypeBlockDataV2) => void = () => undefined): OntologyIr {
  const block = twinObjectType('Account');
  const phase = block.objectType.propertyTypes['phase'];

  if (phase) phase.status = { type: 'experimental', experimental: {} };

  change(block);

  return irOf(block);
}

const v1 = () => account();

const phaseRequired = () =>
  account((block) => {
    const phase = block.objectType.propertyTypes['phase'];

    if (phase) phase.dataConstraints = REQUIRED;
  });

const PHASE_REQUIRED = `Make Property phase required of Object Type ${ACCOUNT}`;

const v2 = () =>
  account((block) => {
    const phase = block.objectType.propertyTypes['phase'];

    delete block.objectType.propertyTypes['phase'];

    if (phase) block.objectType.propertyTypes['stage'] = { ...phase, apiName: 'stage' };
  });

const v3 = () =>
  account((block) => {
    const phase = block.objectType.propertyTypes['phase'];

    delete block.objectType.propertyTypes['phase'];

    if (phase) {
      block.objectType.propertyTypes['stage'] = { ...phase, apiName: 'stage' };
      block.objectType.propertyTypes['region'] = { ...phase, apiName: 'region' };
    }
  });

const policyAccount = (policy: boolean) =>
  account((block) => {
    const source = policiesIr().ontology.objectTypes[ACCOUNT];

    if (!source) throw new Error('The policies IR has no Account.');

    block.objectType.propertyTypes = source.objectType.propertyTypes;

    block.datasources = source.datasources;

    const [datasource] = block.datasources;

    if (!policy && datasource?.datasource.type === 'datasetV3')
      delete datasource.datasource.datasetV3.propertySecurityGroups;
  });

async function store(version: number, ir: unknown, migrations: readonly SchemaMigration[] = []): Promise<void> {
  const metadata = convertOrThrow({ ir, osdkSet: OSDK_SET, validateOnly: false }, TEST_ONTOLOGY_RID, version).metadata;

  await insertVersion(version, ir, metadata, migrations);
}

async function insertVersion(
  version: number,
  ir: unknown,
  metadata: unknown,
  migrations: readonly SchemaMigration[] = [],
  osdkSet: object = OSDK_SET,
): Promise<void> {
  await admin.query(
    `INSERT INTO ontology_registry.product_versions (product, version, ir, metadata, schema_migrations, osdk_set, functions, grants, publisher)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, NULL, $7::jsonb, 'test')`,
    [
      PRODUCT,
      version,
      JSON.stringify(ir),
      JSON.stringify(metadata),
      JSON.stringify({ migrations }),
      JSON.stringify(osdkSet),
      JSON.stringify({ roles: [], objectTypes: {}, actionTypes: {} }),
    ],
  );
}

const UNLISTED_SET = { ...OSDK_SET, '@osdk/client': '0.0.1' };

function metadataOf(version: number, ir: unknown): unknown {
  return convertOrThrow({ ir, osdkSet: OSDK_SET, validateOnly: false }, TEST_ONTOLOGY_RID, version).metadata;
}

interface Installed {
  readonly rid: string;
  readonly apiName: string;
  readonly number: number;
  readonly table: string;
}

async function install(apiName: string, accounts: readonly Record<string, string | null>[] = []): Promise<Installed> {
  const rid = `ri.ontology.main.ontology.${crypto.randomUUID()}`;

  await installOntology(db, { rid, product: PRODUCT, apiName, displayName: apiName, organization: ORGANIZATION });

  const { rows } = await admin.query<{ number: number }>(`SELECT number FROM ${ONTOLOGIES} WHERE rid = $1`, [rid]);

  const number = rows[0]?.number ?? 0;
  const table = `ontology_${number}_objects.account`;

  for (const row of accounts) {
    await admin.query(`INSERT INTO ${table} (account_id, name, phase) VALUES ($1, $2, $3)`, [
      row['accountId'],
      row['name'],
      row['phase'],
    ]);
  }

  return { rid, apiName, number, table };
}

async function registry(): Promise<{ api_name: string; version: number }[]> {
  return (
    await admin.query<{ api_name: string; version: number }>(
      `SELECT api_name, version FROM ${ONTOLOGIES} ORDER BY number`,
    )
  ).rows;
}

async function columns(table: string): Promise<string[]> {
  const [schema, name] = table.split('.');

  const { rows } = await admin.query<{ column_name: string }>(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name',
    [schema, name],
  );

  return rows.map((row) => row.column_name);
}

async function holding(lock: string): Promise<pg.Client> {
  const other = new pg.Client({ connectionString: adminUrl });

  await other.connect();

  await other.query('BEGIN');

  await other.query(lock);

  return other;
}

async function release(other: pg.Client): Promise<void> {
  await other.query('ROLLBACK').catch(() => undefined);

  await other.end();
}

const ACCOUNTS = [
  { accountId: 'a1', name: 'Acme', phase: 'lead' },
  { accountId: 'a2', name: 'Bolt', phase: 'won' },
];

const UNCHANGED = ['__version', 'account_id', 'name', 'phase'];

async function applyPublish(ir: OntologyIr, migrations: readonly SchemaMigration[] = []): Promise<PublishResponse> {
  const request = {
    product: PRODUCT,
    ir: JSON.parse(JSON.stringify(ir)),
    schemaMigrations: { migrations },
    osdkSet: OSDK_SET,
    grants: NO_GRANTS,
    validateOnly: false,
  };

  const ontology = convertOrThrow({ ir, osdkSet: OSDK_SET, validateOnly: false }, TEST_ONTOLOGY_RID, 1);

  return publishOntology(db, {
    product: PRODUCT,
    productRid: TEST_ONTOLOGY_RID,
    ontology,
    request,
    publisher: PUBLISHER,
    mode: APPLY,
  });
}

async function runRestoreChain(installed: Installed): Promise<void> {
  await db.transaction(async (tx) => {
    const locked = await lockInstallation(tx, installed.rid);

    if (!locked) throw new Error(`No registry row ${installed.rid}.`);

    await runChain(tx, locked, chainState());
  });
}

describe('the chain from the version of a row to the newest version', () => {
  it('service/publish#upgrade: a step checks no OSDK set, so a chain moves through a middle version with an unlisted set when the release lists the newest set', async () => {
    await store(1, v1());

    const installed = await install('through', ACCOUNTS);

    await insertVersion(2, v2(), metadataOf(2, v2()), [MOVE_PHASE], UNLISTED_SET);

    await store(3, v3());

    await runRestoreChain(installed);

    expect(await registry()).toEqual([{ api_name: 'through', version: 3 }]);

    expect(await columns(installed.table)).toEqual(['__version', 'account_id', 'name', 'region', 'stage']);
  });
});

describe('the step of a publish', () => {
  it('service/publish#upgrade: a step creates the text search index of a Property that becomes Searchable, and the next step drops it', async () => {
    const searchable = (on: boolean) =>
      account((block) => {
        const name = block.objectType.propertyTypes['name'];

        if (name) name.indexedForSearch = on;
      });

    await applyPublish(searchable(false));

    const installed = await install('search');

    const indexes = async () =>
      (
        await admin.query<{ indexdef: string }>(
          "SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexdef LIKE '%(name ontology_registry.gin_trgm_ops)%'",
          [installed.table.split('.')[0]],
        )
      ).rows.map((row) => row.indexdef);

    await applyPublish(searchable(true));

    expect(await indexes()).toEqual([
      expect.stringMatching(
        new RegExp(
          `^CREATE INDEX trgm_account_name_\\w+ ON ${installed.table} USING gin \\(name ontology_registry\\.gin_trgm_ops\\)$`,
        ),
      ),
    ]);

    await applyPublish(searchable(false));

    expect(await indexes()).toEqual([]);

    expect(await registry()).toEqual([{ api_name: 'search', version: 3 }]);

    await expectAllOnNewest(db);
  });

  it('service/publish#upgrade: a step creates the policy index of a String array Property that the object security policy starts to read, and the next step drops it', async () => {
    await applyPublish(policyAccount(false));

    const installed = await install('policy');

    const schema = installed.table.split('.')[0];

    const indexes = async () =>
      (
        await admin.query<{ indexname: string; indexdef: string }>(
          "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname LIKE 'policy\\_%'",
          [schema],
        )
      ).rows;

    expect(await indexes()).toEqual([]);

    await applyPublish(policyAccount(true));

    expect(await indexes()).toEqual([
      {
        indexname: 'policy_account_viewers_e0c7da57',
        indexdef: `CREATE INDEX policy_account_viewers_e0c7da57 ON ${installed.table} USING gin (COALESCE(array_remove(viewers, NULL::text), '{}'::text[]))`,
      },
    ]);

    await applyPublish(policyAccount(false));

    expect(await indexes()).toEqual([]);

    expect(await registry()).toEqual([{ api_name: 'policy', version: 3 }]);

    await expectAllOnNewest(db);
  });

  it('service/code-layout#seams: the reader of version k returns its stored schema migrations', async () => {
    await store(1, v1());

    await store(2, v2(), [MOVE_PHASE]);

    expect((await readProductVersion(db, PRODUCT, 2))?.schemaMigrations).toEqual([MOVE_PHASE]);

    expect((await readProductVersion(db, PRODUCT, 1))?.schemaMigrations).toEqual([]);

    expect(await readProductVersion(db, PRODUCT, 3)).toBeUndefined();
  });

  it('service/code-layout#seams: the check, with stand-ins, and the chain, with none, plan the same changes for the same step', async () => {
    await store(1, v1());

    const installed = await install('agree', ACCOUNTS);

    await store(2, v3(), [MOVE_PHASE]);

    const [from, to] = [await readProductVersion(db, PRODUCT, 1), await readProductVersion(db, PRODUCT, 2)];

    if (!from || !to) throw new Error('The test stores versions 1 and 2.');

    const schemas = { object: `ontology_${installed.number}_objects`, engine: `ontology_${installed.number}_engine` };

    const plan = (standIns: boolean) =>
      planStep(db, schemas, compileOrThrow(from), compileOrThrow(to), to.schemaMigrations, {
        standIns,
        hasStoredValues: true,
      });

    const check = await plan(true);

    expect(check.map((change) => change.description)).toEqual([
      `Move Property phase to stage of Object Type ${ACCOUNT}`,
      `Create Property region of Object Type ${ACCOUNT}`,
    ]);

    expect(await plan(false)).toEqual(check);
  });

  it('the step plans again under its table locks, so a write that commits during the lock wait fails the publish, and nothing moves', async () => {
    await applyPublish(v1());

    const installed = await install('replan', ACCOUNTS);

    const other = await holding(`UPDATE ${installed.table} SET phase = NULL WHERE account_id = 'a1'`);

    try {
      const running = applyPublish(phaseRequired()).then(
        () => undefined,
        (error: unknown) => error,
      );

      await waitForLockWaits(db, 1);

      await other.query('COMMIT');

      expect(await running).toMatchObject({
        status: 400,
        errorName: 'Default:InvalidArgument',
        parameters: {
          change: PHASE_REQUIRED,
          objectType: ACCOUNT,
          property: 'phase',
          badObjects: 1,
          primaryKeys: ['a1'],
          ontologyRid: installed.rid,
        },
      });
    } finally {
      await release(other);
    }

    expect(await registry()).toEqual([{ api_name: 'replan', version: 1 }]);

    expect(await columns(installed.table)).toEqual(UNCHANGED);

    await expectAllOnNewest(db);
  });
});
