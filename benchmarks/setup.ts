import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { defineCreateObjectAction, defineObject, defineOntology } from '@osdk/maker';
import { defineFunctionBackedAction } from '@osdk/maker-experimental';
import pg from 'pg';
import { applyEngineChanges, createDb, createNodeServer, createPool, inputFromEnv } from '@ericbragas/ontos-service';

const run = promisify(execFile);

const POSTGRES_IMAGE = 'mirror.gcr.io/library/postgres:17-alpine';
const BENCH_TOKEN = 'ontos-benchmark-token';
const BENCH_NS = 'com.ontos.bench.';
const ITEM_TYPE = `${BENCH_NS}Item`;
const SECURED_ITEM_TYPE = `${BENCH_NS}SecuredItem`;
const PRODUCT = 'bench';

export interface BenchEnv {
  readonly baseUrl: string;
  readonly ontologyRid: string;
  readonly token: string;
  readonly itemType: string;
  readonly securedItemType: string;
  readonly postgresVersion: string;
  readonly pool: pg.Pool;
  readonly runEngineChangesFastPath: () => Promise<void>;
  readonly countItems: () => Promise<number>;
  readonly stop: () => Promise<void>;
}

const FUNCTION_BUNDLE = `
export const createClient = (baseUrl, ontologyRid, token, options, fetch) => ({ baseUrl, ontologyRid, fetch });
export const functions = {
  createBatch: async (_client, prefix, count) => {
    const edits = [];
    for (let index = 0; index < count; index += 1) {
      edits.push({
        type: 'createObject',
        obj: { apiName: '${ITEM_TYPE}' },
        properties: {
          itemId: prefix + '-' + index,
          title: 'Batch entry ' + prefix + ' alpha ' + index,
          category: 'cat-' + (index % 10),
          amount: (index % 100) + 1,
          ownerId: 'user_dev',
        },
      });
    }
    return edits;
  },
  updateItem: async (client, itemId, amount) => {
    const response = await client.fetch(
      client.baseUrl + '/api/v2/ontologies/' + client.ontologyRid + '/objectSets/loadObjects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          objectSet: {
            type: 'filter',
            objectSet: { type: 'base', objectType: '${ITEM_TYPE}' },
            where: { type: 'eq', field: 'itemId', value: itemId },
          },
          pageSize: 1,
        }),
      },
    );
    if (!response.ok) throw new Error('Bridge read failed: ' + response.status);
    const loaded = await response.json();
    const row = loaded.data?.[0];
    if (!row) throw new Error('Item not found: ' + itemId);
    return [{
      type: 'updateObject',
      obj: { $apiName: '${ITEM_TYPE}', $primaryKey: row.itemId },
      properties: { amount },
    }];
  },
};
`;

const DISCOVERED_FUNCTIONS = [
  {
    locator: { type: 'typescript', typescript: { functionName: 'createBatch' } },
    inputs: [
      { name: 'client', dataType: { type: 'client', client: {} } },
      { name: 'prefix', dataType: { type: 'string', string: {} }, required: true },
      { name: 'count', dataType: { type: 'integer', integer: {} }, required: true },
    ],
    output: {
      single: {
        dataType: { type: 'list', list: { elementsType: { type: 'ontologyEdit', ontologyEdit: {} } } },
      },
    },
    customTypes: {},
    ontologyProvenance: {
      editedObjects: { [ITEM_TYPE]: {} },
      editedLinks: {},
      editedInterfaces: {},
    },
  },
  {
    locator: { type: 'typescript', typescript: { functionName: 'updateItem' } },
    inputs: [
      { name: 'client', dataType: { type: 'client', client: {} } },
      { name: 'itemId', dataType: { type: 'string', string: {} }, required: true },
      { name: 'amount', dataType: { type: 'double', double: {} }, required: true },
    ],
    output: {
      single: {
        dataType: { type: 'list', list: { elementsType: { type: 'ontologyEdit', ontologyEdit: {} } } },
      },
    },
    customTypes: {},
    ontologyProvenance: {
      editedObjects: { [ITEM_TYPE]: {} },
      editedLinks: {},
      editedInterfaces: {},
    },
  },
];

async function buildBenchmarkIr() {
  const userId = { type: 'userProperty', userProperty: { type: 'userId', userId: {} } } as const;

  return defineOntology(BENCH_NS, () => {
    const item = defineObject({
      apiName: 'Item',
      displayName: 'Item',
      pluralDisplayName: 'Items',
      titlePropertyApiName: 'title',
      primaryKeyPropertyApiName: 'itemId',
      properties: {
        itemId: { type: 'string', displayName: 'Item ID' },
        title: { type: 'string', nullability: { noNulls: true, noEmptyCollections: false } },
        category: { type: 'string' },
        amount: { type: 'double' },
        ownerId: { type: 'string' },
      },
      editsEnabled: true,
      includeEmptyBackingDatasource: true,
    });

    defineObject({
      apiName: 'SecuredItem',
      displayName: 'Secured Item',
      pluralDisplayName: 'Secured Items',
      titlePropertyApiName: 'title',
      primaryKeyPropertyApiName: 'itemId',
      properties: {
        itemId: { type: 'string', displayName: 'Item ID' },
        title: { type: 'string', nullability: { noNulls: true, noEmptyCollections: false } },
        category: { type: 'string' },
        amount: { type: 'double' },
        ownerId: { type: 'string' },
      },
      editsEnabled: true,
      datasources: [
        {
          type: 'dataset',
          objectSecurityPolicy: {
            name: 'own',
            granularPolicy: {
              type: 'comparison',
              comparison: { left: { type: 'property', property: 'ownerId' }, operator: 'EQUAL', right: userId },
            },
          },
        },
      ],
    });

    defineCreateObjectAction({ objectType: item, apiName: 'create-item' });

    defineFunctionBackedAction({
      functionApiName: 'createBatch',
      apiName: 'create-batch',
      displayName: 'Create batch',
    });

    defineFunctionBackedAction({
      functionApiName: 'updateItem',
      apiName: 'update-item',
      displayName: 'Update item',
    });
  });
}

async function startPostgresContainer(name: string): Promise<string> {
  await run('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '-e',
    'POSTGRES_PASSWORD=bench',
    '-p',
    '127.0.0.1::5432',
    POSTGRES_IMAGE,
    '-c',
    'max_connections=200',
  ]);

  const { stdout } = await run('docker', ['port', name, '5432/tcp']);

  const port = stdout.trim().split('\n')[0]?.split(':').pop();

  if (!port) throw new Error(`No port found for container ${name}.`);

  const url = `postgresql://postgres:bench@127.0.0.1:${port}/postgres`;

  for (let attempt = 0; attempt < 300; attempt += 1) {
    const client = new pg.Client({ connectionString: url });

    try {
      await client.connect();

      await client.query('SELECT 1');

      await client.end();

      return url;
    } catch {
      await client.end().catch(() => undefined);

      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error(`Postgres container ${name} did not become ready.`);
}

async function drainFallible(gen: AsyncGenerator<unknown, unknown, unknown>): Promise<void> {
  const step = await gen.next();

  if (step.done !== true) {
    const err = step.value as { error?: unknown } | undefined;

    throw err?.error instanceof Error ? err.error : new Error(String(step.value));
  }
}

export async function startBenchEnv(): Promise<BenchEnv> {
  const id = randomUUID().replaceAll('-', '').slice(0, 10);
  const container = `ontos-bench-${id}`;

  const adminUrl = await startPostgresContainer(container);

  const admin = new pg.Client({ connectionString: adminUrl });

  await admin.connect();

  let server: ReturnType<typeof createNodeServer> | undefined;
  let pool: pg.Pool | undefined;

  try {
    const versionRow = await admin.query<{ server_version: string }>('SHOW server_version');

    const postgresVersion = versionRow.rows[0]?.server_version ?? 'unknown';

    await admin.query(`CREATE DATABASE bench_${id} TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'und'`);

    await admin.end();

    const dbUrl = Object.assign(new URL(adminUrl), { pathname: `/bench_${id}` }).toString();

    pool = createPool(dbUrl, { max: 20 });

    const directDb = createDb(pool);

    await drainFallible(applyEngineChanges(directDb));

    const input = inputFromEnv(
      {
        ONTOS_AUTH_MODE: 'dev',
        ONTOS_DEV_TOKEN: BENCH_TOKEN,
        DATABASE_URL: dbUrl,
        ONTOLOGY_ENVIRONMENT: 'benchmark',
      },
      () => pool as pg.Pool,
    );

    if ('missing' in input) throw new Error(`Missing settings: ${input.missing.join(', ')}`);

    server = createNodeServer(input);

    const baseUrl = await new Promise<string>((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const address = server?.address() as AddressInfo;

        resolve(`http://127.0.0.1:${address.port}`);
      });
    });

    const ir = await buildBenchmarkIr();

    const sets = JSON.parse(readFileSync(new URL('../packages/service/osdk-sets.json', import.meta.url), 'utf8')) as {
      packages: Record<string, string>;
    }[];

    const osdkSet = sets[0]?.packages;

    if (!osdkSet) throw new Error('Expected at least one OSDK set in packages/service/osdk-sets.json.');

    const grants = {
      permissions: { 'bench:use': { description: 'Run benchmark reads and writes' } },
      objectTypes: { [ITEM_TYPE]: 'bench:use', [SECURED_ITEM_TYPE]: 'bench:use' },
      actionTypes: {
        [`${BENCH_NS}create-item`]: 'bench:use',
        [`${BENCH_NS}create-batch`]: 'bench:use',
        [`${BENCH_NS}update-item`]: 'bench:use',
      },
      defaultRoles: { admin: ['ontology:install', 'bench:use'] },
    };

    const publishRes = await fetch(`${baseUrl}/api/ontology-service/v1/publish`, {
      method: 'POST',
      headers: { authorization: `Bearer ${BENCH_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        product: PRODUCT,
        ir,
        schemaMigrations: { migrations: [] },
        osdkSet,
        grants,
        functions: { discovered: DISCOVERED_FUNCTIONS, bundle: FUNCTION_BUNDLE },
        validateOnly: false,
      }),
    });

    if (!publishRes.ok) throw new Error(`Publish failed (${publishRes.status}): ${await publishRes.text()}`);

    const installRes = await fetch(`${baseUrl}/api/ontology-service/v1/ontologies`, {
      method: 'POST',
      headers: { authorization: `Bearer ${BENCH_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ product: PRODUCT, apiName: PRODUCT, displayName: 'Benchmark' }),
    });

    if (!installRes.ok) throw new Error(`Install failed (${installRes.status}): ${await installRes.text()}`);

    const installed = (await installRes.json()) as { rid: string };

    const ontologyRid = installed.rid;

    const itemIds: string[] = [];
    const titles: string[] = [];
    const categories: string[] = [];
    const amounts: number[] = [];
    const owners: string[] = [];

    for (let index = 0; index < 1_000; index += 1) {
      itemIds.push(`item-${String(index).padStart(4, '0')}`);

      titles.push(index % 10 === 0 ? `Quarterly Horizon Report ${index}` : `Standard Ledger Entry ${index}`);

      categories.push(`cat-${index % 10}`);

      amounts.push((index % 100) + 1);

      owners.push(index % 5 === 0 ? 'user_dev' : 'user_other');
    }

    await pool.query(
      `INSERT INTO ontology_1_objects.item (item_id, title, category, amount, owner_id)
       SELECT id, title, cat, amt, owner
       FROM unnest($1::text[], $2::text[], $3::text[], $4::double precision[], $5::text[]) AS t(id, title, cat, amt, owner)`,
      [itemIds, titles, categories, amounts, owners],
    );

    await pool.query(
      `INSERT INTO ontology_1_objects.secured_item (item_id, title, category, amount, owner_id)
       SELECT id, title, cat, amt, owner
       FROM unnest($1::text[], $2::text[], $3::text[], $4::double precision[], $5::text[]) AS t(id, title, cat, amt, owner)`,
      [itemIds, titles, categories, amounts, owners],
    );

    await pool.query('ANALYZE ontology_1_objects.item');

    await pool.query('ANALYZE ontology_1_objects.secured_item');

    const activePool = pool;

    return {
      baseUrl,
      ontologyRid,
      token: BENCH_TOKEN,
      itemType: ITEM_TYPE,
      securedItemType: SECURED_ITEM_TYPE,
      postgresVersion,
      pool: activePool,
      runEngineChangesFastPath: () => drainFallible(applyEngineChanges(directDb)),
      countItems: async () => {
        const res = await activePool.query<{ n: string }>('SELECT count(*) AS n FROM ontology_1_objects.item');

        return Number(res.rows[0]?.n ?? 0);
      },
      stop: async () => {
        if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));

        await activePool.end();

        await run('docker', ['rm', '-f', container]).catch(() => undefined);
      },
    };
  } catch (error) {
    await admin.end().catch(() => undefined);

    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));

    await pool?.end().catch(() => undefined);

    await run('docker', ['rm', '-f', container]).catch(() => undefined);

    throw error;
  }
}
