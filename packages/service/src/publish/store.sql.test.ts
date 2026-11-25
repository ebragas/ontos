import type { OntologyIr } from '@osdk/client.unstable';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../db/index.ts';
import { createDb, type Db } from '../db/promise.test-utils.ts';

import type { PublishResponse, SchemaMigration } from './index.ts';
import { installOntology } from '../install.test-utils.ts';
import { convertOrThrow, grantsOf, irOf, NS, stringProperty, twinObjectType } from '../ontology/stored.test-utils.ts';
import { createEngineTemplate, startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { TEST_ONTOLOGY_RID } from '../service.test-utils.ts';
import { ORGANIZATION } from '../tokens.test-utils.ts';
import {
  APPLY,
  expectAllOnNewest,
  modeOf,
  onNewConnection,
  OSDK_SET,
  PUBLISHER,
  publishOntology,
  refusal,
  waitForLockWaits,
} from './publish.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const PRODUCT = 'twin';
const ONTOLOGIES = 'ontology_registry.ontologies';
const VERSIONS = 'ontology_registry.product_versions';
const LOCK_VERSIONS = `LOCK TABLE ${VERSIONS} IN EXCLUSIVE MODE`;
const DROP_REGION: SchemaMigration = { type: 'dropProperty', objectType: ACCOUNT, property: 'region' };
const SERVICE_PASSWORD = 'store-role-test-only';

let postgres: TestPostgres;
let serviceRole: string;
let template: string;
let databases = 0;
let admin: pg.Client;
let adminUrl: string;
let pool: pg.Pool;
let serviceUrl: string;
let db: Db;
const others: pg.Client[] = [];

beforeAll(async () => {
  postgres = await startPostgres();

  serviceRole = `${postgres.role}_store`;

  await onNewConnection(
    postgres.url,
    `CREATE ROLE ${serviceRole} LOGIN PASSWORD '${SERVICE_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );

  template = await createEngineTemplate(postgres.url, { name: serviceRole, password: SERVICE_PASSWORD });
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  const name = `${postgres.role}_store_${++databases}`;

  await onNewConnection(postgres.url, `CREATE DATABASE ${name} TEMPLATE ${template}`);

  await onNewConnection(postgres.url, `GRANT CREATE ON DATABASE ${name} TO ${serviceRole}`);

  const url = new URL(postgres.url);

  url.pathname = `/${name}`;

  adminUrl = url.toString();

  admin = new pg.Client({ connectionString: adminUrl });

  await admin.connect();

  url.username = serviceRole;
  url.password = SERVICE_PASSWORD;

  serviceUrl = url.toString();

  pool = createPool(serviceUrl);

  db = createDb(pool);
});

afterEach(async () => {
  await expectAllOnNewest(db);

  for (const other of others.splice(0)) await other.end().catch(() => undefined);

  await admin.end();

  await pool.end();
});

function account(...extra: string[]): OntologyIr {
  const block = twinObjectType('Account');

  for (const name of extra)
    block.objectType.propertyTypes[name] = {
      ...stringProperty(name),
      status: { type: 'experimental', experimental: {} },
    };

  return irOf(block);
}

interface PublishOptions {
  readonly validateOnly?: boolean;
  readonly migrations?: readonly SchemaMigration[];
  readonly between?: () => Promise<void>;
  readonly onStatement?: (text: string, tx: Db) => Promise<void>;
  readonly grants?: ReturnType<typeof grantsOf>;
}

function publish(ir: OntologyIr, options: PublishOptions = {}): Promise<PublishResponse> {
  const validateOnly = options.validateOnly ?? false;
  const ontology = convertOrThrow({ ir, osdkSet: OSDK_SET, validateOnly }, TEST_ONTOLOGY_RID, 1);

  const request = {
    product: PRODUCT,
    ir: JSON.parse(JSON.stringify(ir)),
    schemaMigrations: { migrations: options.migrations ?? [] },
    osdkSet: OSDK_SET,
    grants: options.grants ?? grantsOf(ir),
    validateOnly,
  };

  return publishOntology(hooked(db, options), {
    product: PRODUCT,
    productRid: TEST_ONTOLOGY_RID,
    ontology,
    request,
    publisher: PUBLISHER,
    mode: modeOf(validateOnly),
  });
}

function hooked(base: Db, options: PublishOptions): Db {
  const inside = (tx: Db): Db => ({
    ...tx,
    query: async (statement) => {
      await options.onStatement?.(statement.text, tx);

      return tx.query(statement);
    },
  });

  return {
    ...base,
    transaction: async (run) => {
      await options.between?.();

      return base.transaction((tx) => run(inside(tx)));
    },
  };
}

async function install(apiName: string): Promise<string> {
  const rid = `ri.ontology.main.ontology.${crypto.randomUUID()}`;

  await installOntology(db, { rid, product: PRODUCT, apiName, displayName: apiName, organization: ORGANIZATION });

  return rid;
}

async function setHeld(rid: string, held: boolean): Promise<void> {
  await admin.query(`UPDATE ${ONTOLOGIES} SET held = $1 WHERE rid = $2`, [held, rid]);
}

async function registry(): Promise<string[]> {
  const { rows } = await admin.query<{ row: string }>(
    `SELECT api_name || ' ' || version AS row FROM ${ONTOLOGIES} ORDER BY number`,
  );

  return rows.map((row) => row.row);
}

async function versions(): Promise<number[]> {
  return (await admin.query<{ version: number }>(`SELECT version FROM ${VERSIONS} ORDER BY version`)).rows.map(
    (row) => row.version,
  );
}

async function accountColumns(): Promise<string[]> {
  const { rows } = await admin.query<{ name: string }>(
    "SELECT table_schema || '.' || column_name AS name FROM information_schema.columns WHERE table_name = 'account' ORDER BY table_schema, column_name",
  );

  return rows.map((row) => row.name);
}

async function holding(...locks: string[]): Promise<pg.Client> {
  const other = new pg.Client({ connectionString: adminUrl });

  await other.connect();

  others.push(other);

  await other.query('BEGIN');

  for (const lock of locks) await other.query(lock);

  return other;
}

describe('the check', () => {
  it('when the plan of 1 installation fails, the publish stores nothing, and the error names that installation and the change', async () => {
    await publish(account('region'));

    await install('a');

    const b = await install('b');

    await admin.query(
      "INSERT INTO ontology_2_objects.account (account_id, name, region) VALUES ('acc-1', 'Acme', 'west')",
    );

    for (const validateOnly of [true, false]) {
      const error = await refusal(publish(account(), { validateOnly }));

      expect([error.status, error.errorName, error.parameters]).toEqual([
        400,
        'Default:InvalidArgument',
        {
          change: `Delete Property region of Object Type ${ACCOUNT}`,
          schemaMigrations: ['dropProperty'],
          ontologyRid: b,
        },
      ]);
    }

    expect(await versions()).toEqual([1]);

    expect(await registry()).toEqual(['a 1', 'b 1']);
  });
});

describe('the store', () => {
  it('a publish stores 1 product version, and moves each installation and its tables to it', async () => {
    await publish(account());

    await install('a');

    await install('b');

    const response = await publish(account('region'));

    expect([response.version, response.changes]).toEqual([
      2,
      [{ description: `Create Property region of Object Type ${ACCOUNT}` }],
    ]);

    expect(await versions()).toEqual([1, 2]);

    expect(await registry()).toEqual(['a 2', 'b 2']);

    expect((await accountColumns()).filter((column) => column.endsWith('.region'))).toEqual([
      'ontology_1_objects.region',
      'ontology_2_objects.region',
    ]);
  });

  it('a publish of only grants stores 1 version with no change, and raises each installation', async () => {
    const ir = account();

    await publish(ir);

    await install('a');

    const response = await publish(ir, { grants: grantsOf(ir, ['admin']) });

    expect([response.version, response.changes]).toEqual([2, []]);

    expect(await registry()).toEqual(['a 2']);
  });

  it('a publish with the same parts stores no version, and a validateOnly publish stores none', async () => {
    const ir = account();

    await publish(ir);

    await install('a');

    expect(await publish(ir)).toMatchObject({ version: 1, changes: [] });

    expect((await publish(account('region'), { validateOnly: true })).version).toBeUndefined();

    expect(await versions()).toEqual([1]);

    expect(await registry()).toEqual(['a 1']);
  });

  it('the transaction runs with lock_timeout 5s and transaction_timeout 60s, and inserts 1 product version', async () => {
    await publish(account());

    await install('a');

    const seen: string[] = [];

    await publish(account('region'), {
      onStatement: async (text, tx) => {
        if (!/^\s*(LOCK|INSERT|ALTER ROLE)\b/i.test(text)) return;

        const [row] = await tx.query<{ lock: string; time: string }>({
          text: "SELECT current_setting('lock_timeout') AS lock, current_setting('transaction_timeout') AS time",
          values: [],
        });

        seen.push(`${text.trim().split(/\s+/).slice(0, 2).join(' ')} ${row?.lock} ${row?.time}`);
      },
    });

    expect(seen).toEqual([
      'LOCK TABLE 5s 1min',
      'ALTER ROLE 5s 1min',
      'ALTER ROLE 5s 1min',
      'ALTER ROLE 5s 1min',
      'ALTER ROLE 5s 1min',
      'INSERT INTO 5s 1min',
      'LOCK TABLE 5s 1min',
    ]);
  });

  it('the lock and time limits of the store end with its transaction, and do not stay on the connection', async () => {
    const one = createPool(serviceUrl, { max: 1 });

    try {
      const single = createDb(one);
      const ontology = convertOrThrow({ ir: account(), osdkSet: OSDK_SET, validateOnly: false }, TEST_ONTOLOGY_RID, 1);

      const request = {
        product: PRODUCT,
        ir: JSON.parse(JSON.stringify(account())),
        schemaMigrations: { migrations: [] },
        osdkSet: OSDK_SET,
        grants: grantsOf(account()),
        validateOnly: false,
      };

      expect(
        (
          await publishOntology(single, {
            product: PRODUCT,
            productRid: TEST_ONTOLOGY_RID,
            ontology,
            request,
            publisher: PUBLISHER,
            mode: APPLY,
          })
        ).version,
      ).toBe(1);

      const [row] = await single.query<{ lock: string; time: string }>({
        text: "SELECT current_setting('lock_timeout') AS lock, current_setting('transaction_timeout') AS time",
        values: [],
      });

      expect(row).toEqual({ lock: '0', time: '0' });
    } finally {
      await one.end();
    }
  });

  it('service/publish#applying: a second store between the check and the store gives 409 PublishLockTimeout with phase version, and stores nothing', async () => {
    await publish(account());

    await install('a');

    const metadata = convertOrThrow(
      { ir: account('segment'), osdkSet: OSDK_SET, validateOnly: false },
      TEST_ONTOLOGY_RID,
      2,
    ).metadata;

    let other: pg.Client | undefined;

    const refused = refusal(
      publish(account('region'), {
        between: async () => {
          other = await holding(LOCK_VERSIONS);
        },
      }),
    );

    await waitForLockWaits(db, 1);

    await other?.query(
      `INSERT INTO ${VERSIONS} (product, version, ir, metadata, schema_migrations, osdk_set, functions, grants, publisher)
       VALUES ($1, 2, $2::jsonb, $3::jsonb, '{"migrations":[]}'::jsonb, $4::jsonb, NULL, $5::jsonb, 'other')`,
      [
        PRODUCT,
        JSON.stringify(account('segment')),
        JSON.stringify(metadata),
        JSON.stringify(OSDK_SET),
        JSON.stringify(grantsOf(account('segment'))),
      ],
    );

    await other?.query(`UPDATE ${ONTOLOGIES} SET version = 2`);

    await other?.query('COMMIT');

    const error = await refused;

    expect([error.status, error.errorName, error.parameters]).toEqual([
      409,
      'PublishLockTimeout',
      { phase: 'version', table: VERSIONS, changed: false, transactionMs: expect.any(Number) },
    ]);

    expect(
      (
        await admin.query<{ row: string }>(
          `SELECT version || ' ' || publisher AS row FROM ${VERSIONS} ORDER BY version`,
        )
      ).rows.map((row) => row.row),
    ).toEqual([`1 ${PUBLISHER}`, '2 other']);
  });

  it('an install between the check and the transaction starts at the version before, and the transaction moves it', async () => {
    await publish(account());

    await install('a');

    const response = await publish(account('region'), {
      between: async () => {
        await install('late');
      },
    });

    expect(response.version).toBe(2);

    expect(await registry()).toEqual(['a 2', 'late 2']);

    expect((await accountColumns()).filter((column) => column.endsWith('.region'))).toEqual([
      'ontology_1_objects.region',
      'ontology_2_objects.region',
    ]);
  });
});

describe('the publish job', () => {
  it('service/publish#applying: 2 jobs at once: the store of the second job between the check and the store of the first gives the first 409 PublishLockTimeout, and its rerun stores the next version', async () => {
    await publish(account());

    await install('a');

    const error = await refusal(
      publish(account('segment'), {
        between: async () => {
          expect((await publish(account('region'))).version).toBe(2);
        },
      }),
    );

    expect([error.errorName, error.parameters]).toEqual([
      'PublishLockTimeout',
      { phase: 'version', table: VERSIONS, changed: false, transactionMs: expect.any(Number) },
    ]);

    expect(await registry()).toEqual(['a 2']);

    const rerun = await publish(account('segment'), { migrations: [DROP_REGION] });

    expect([rerun.version, rerun.changes]).toEqual([
      3,
      [
        { description: `Delete Property region of Object Type ${ACCOUNT}`, migration: DROP_REGION },
        { description: `Create Property segment of Object Type ${ACCOUNT}` },
      ],
    ]);

    expect(await versions()).toEqual([1, 2, 3]);
  });
});

describe('a row with held = true', () => {
  const FIRST = 'ri.ontology.main.ontology.00000000-0000-4000-8000-0000000000a1';
  const SECOND = 'ri.ontology.main.ontology.00000000-0000-4000-8000-0000000000a2';

  async function rows(): Promise<unknown[]> {
    const text = `SELECT number, rid, api_name, display_name, object_schema, engine_schema, product, version, organization, engine_change_count, held FROM ${ONTOLOGIES} ORDER BY number`;

    return (await admin.query(text)).rows;
  }

  it('service/storage#registry: as a role that is not a superuser, the registry row has each listed field, and the first publish on a database with a row with held = true moves that row, and a publish and an install write no held', async () => {
    await publish(account());

    await installOntology(db, {
      rid: FIRST,
      product: PRODUCT,
      apiName: 'first',
      displayName: 'First',
      organization: ORGANIZATION,
    });

    await setHeld(FIRST, true);

    await publish(account('region'));

    await installOntology(db, {
      rid: SECOND,
      product: PRODUCT,
      apiName: 'second',
      displayName: 'Second',
      organization: ORGANIZATION,
    });

    await publish(account('region', 'segment'));

    const row = { product: 'twin', version: 3, organization: 'org_01TEST0RG00000000000000001', engine_change_count: 3 };

    expect(await rows()).toEqual([
      {
        number: 1,
        rid: FIRST,
        api_name: 'first',
        display_name: 'First',
        object_schema: 'ontology_1_objects',
        engine_schema: 'ontology_1_engine',
        ...row,
        held: true,
      },
      {
        number: 2,
        rid: SECOND,
        api_name: 'second',
        display_name: 'Second',
        object_schema: 'ontology_2_objects',
        engine_schema: 'ontology_2_engine',
        ...row,
        held: false,
      },
    ]);
  });

  it('service/publish#upgrade: the check plans a row with held = true as each other row: no warning, and its data fails the publish by its RID', async () => {
    await publish(account('region'));

    await installOntology(db, {
      rid: FIRST,
      product: PRODUCT,
      apiName: 'first',
      displayName: 'First',
      organization: ORGANIZATION,
    });

    await installOntology(db, {
      rid: SECOND,
      product: PRODUCT,
      apiName: 'second',
      displayName: 'Second',
      organization: ORGANIZATION,
    });

    await setHeld(SECOND, true);

    const checked = await publish(account(), { validateOnly: true });

    expect([checked.version, checked.warnings, checked.changes]).toEqual([
      undefined,
      undefined,
      [{ description: `Delete Property region of Object Type ${ACCOUNT}` }],
    ]);

    await admin.query(
      "INSERT INTO ontology_2_objects.account (account_id, name, region) VALUES ('acc-1', 'Acme', 'west')",
    );

    for (const validateOnly of [true, false]) {
      const error = await refusal(publish(account(), { validateOnly }));

      expect([error.status, error.errorName, error.parameters]).toEqual([
        400,
        'Default:InvalidArgument',
        {
          change: `Delete Property region of Object Type ${ACCOUNT}`,
          schemaMigrations: ['dropProperty'],
          ontologyRid: SECOND,
        },
      ]);
    }

    expect(await versions()).toEqual([1]);
  });

  it('service/releases#compatibility-with-earlier-releases: the query of an operator before the first deploy counts each held or behind installation, with and without the held column', async () => {
    const WITH_HELD =
      'SELECT count(*)::int AS count FROM ontology_registry.ontologies o WHERE o.held OR o.version < (SELECT max(v.version) FROM ontology_registry.product_versions v WHERE v.product = o.product)';

    const WITHOUT_HELD =
      'SELECT count(*)::int AS count FROM ontology_registry.ontologies o WHERE o.version < (SELECT max(v.version) FROM ontology_registry.product_versions v WHERE v.product = o.product)';

    const count = async (text: string) => (await admin.query<{ count: number }>(text)).rows[0]?.count;

    await publish(account());

    await installOntology(db, {
      rid: FIRST,
      product: PRODUCT,
      apiName: 'first',
      displayName: 'First',
      organization: ORGANIZATION,
    });

    await installOntology(db, {
      rid: SECOND,
      product: PRODUCT,
      apiName: 'second',
      displayName: 'Second',
      organization: ORGANIZATION,
    });

    await publish(account('region'));

    expect(await count(WITH_HELD)).toBe(0);

    await setHeld(SECOND, true);

    expect(await count(WITH_HELD)).toBe(1);

    await setHeld(SECOND, false);

    await admin.query(`UPDATE ${ONTOLOGIES} SET version = 1 WHERE rid = $1`, [FIRST]);

    expect(await count(WITH_HELD)).toBe(1);

    await admin.query(`ALTER TABLE ${ONTOLOGIES} DROP COLUMN held`);

    expect(await count(WITHOUT_HELD)).toBe(1);

    await admin.query(`UPDATE ${ONTOLOGIES} SET version = 2 WHERE rid = $1`, [FIRST]);

    expect(await count(WITHOUT_HELD)).toBe(0);
  });
});
