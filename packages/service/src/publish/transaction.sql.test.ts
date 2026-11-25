import type { OntologyIr, OntologyIrObjectTypeBlockDataV2 } from '@osdk/client.unstable';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPool, type Sql } from '../db/index.ts';
import { applyEngineChanges, createDb, type Db, fallibleOf } from '../db/promise.test-utils.ts';
import { ApiError } from '../errors/index.ts';
import { handle } from '../handler/index.ts';

import type { PublishResponse, SchemaMigration } from './index.ts';
import { installOntology } from '../install.test-utils.ts';
import { type PublishLog, type PublishMode } from './publishOntology.ts';
import type { FinishedSpan } from '../spans/index.ts';
import { convertOrThrow, grantsOf, irOf, NS, twinObjectType } from '../ontology/stored.test-utils.ts';
import { createEngineTemplate, startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { buffered, routeSpans } from '../routeHarness.test-utils.ts';
import { noUsers, TEST_ONTOLOGY_RID, testSettings } from '../service.test-utils.ts';
import { createTestIssuer, ORGANIZATION, type TestIssuer } from '../tokens.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';
import {
  APPLY,
  CHECK,
  expectAllOnNewest,
  NO_GRANTS,
  OSDK_SET,
  PUBLISHER,
  publishOntology,
  waitForLockWaits,
} from './publish.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const PRODUCT = 'twin';
const ONTOLOGIES = 'ontology_registry.ontologies';
const VERSIONS = 'ontology_registry.product_versions';
const REQUIRED = { nullabilityV2: { noNulls: true, noEmptyCollections: false }, propertyTypeConstraints: [] };
const PHASE_REQUIRED = `Make Property phase required of Object Type ${ACCOUNT}`;
const SERVICE_PASSWORD = 'transaction-role-test-only';

let postgres: TestPostgres;
let serviceRole: string;
let template: string;
let databases = 0;
let admin: pg.Client;
let adminUrl: string;
let serviceUrl: string;
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
  const name = `${postgres.role}_transaction_${++databases}`;

  await onAdmin(postgres.url, `CREATE DATABASE ${name} TEMPLATE ${template}`);

  await onAdmin(postgres.url, `GRANT CREATE ON DATABASE ${name} TO ${serviceRole}`);

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

  await db.query({ text: 'ALTER ROLE CURRENT_USER RESET ALL', values: [] });
});

afterEach(async () => {
  await expectAllOnNewest(db);

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

const withRegion = () =>
  account((block) => {
    const phase = block.objectType.propertyTypes['phase'];

    if (phase) block.objectType.propertyTypes['region'] = { ...phase, apiName: 'region' };
  });

interface PublishOptions {
  readonly mode?: PublishMode;
  readonly migrations?: readonly SchemaMigration[];
  readonly between?: () => Promise<void>;
  readonly inTransaction?: (tx: Db) => Db;
  readonly transactionTimeout?: string;
  readonly log?: (log: PublishLog) => void;
}

function publish(ir: OntologyIr, options: PublishOptions = {}, on: Db = db): Promise<PublishResponse> {
  const mode = options.mode ?? APPLY;
  const validateOnly = mode.kind === 'check';

  const request = {
    product: PRODUCT,
    ir: JSON.parse(JSON.stringify(ir)),
    schemaMigrations: { migrations: options.migrations ?? [] },
    osdkSet: OSDK_SET,
    grants: NO_GRANTS,
    validateOnly,
  };

  const hooked: Db = {
    ...on,
    transaction: async (run) => {
      await options.between?.();

      return on.transaction((tx) => run(options.inTransaction ? options.inTransaction(tx) : tx));
    },
  };

  return publishOntology(hooked, {
    product: PRODUCT,
    productRid: TEST_ONTOLOGY_RID,
    ontology: convertOrThrow({ ir, osdkSet: OSDK_SET, validateOnly }, TEST_ONTOLOGY_RID, 1),
    request,
    publisher: PUBLISHER,
    mode,
    ...(options.transactionTimeout ? { transactionTimeout: options.transactionTimeout } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
}

interface Installed {
  readonly rid: string;
  readonly number: number;
  readonly table: string;
}

const ACCOUNTS = [
  { accountId: 'a1', name: 'Acme', phase: 'lead' },
  { accountId: 'a2', name: 'Bolt', phase: 'won' },
];

async function install(
  apiName: string,
  accounts: readonly Record<string, string | null>[] = ACCOUNTS,
): Promise<Installed> {
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

  return { rid, number, table };
}

async function threeInstallations(): Promise<Installed[]> {
  await publish(v1());

  return [await install('first'), await install('middle'), await install('last')];
}

async function registry(): Promise<number[]> {
  return (await admin.query<{ version: number }>(`SELECT version FROM ${ONTOLOGIES} ORDER BY number`)).rows.map(
    (row) => row.version,
  );
}

async function versions(): Promise<number[]> {
  return (await admin.query<{ version: number }>(`SELECT version FROM ${VERSIONS} ORDER BY version`)).rows.map(
    (row) => row.version,
  );
}

async function phaseNullable(installed: readonly Installed[]): Promise<string[]> {
  const result: string[] = [];

  for (const { table } of installed) {
    const [schema, name] = table.split('.');

    const { rows } = await admin.query<{ is_nullable: string }>(
      "SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = 'phase'",
      [schema, name],
    );

    result.push(rows[0]?.is_nullable ?? 'missing');
  }

  return result;
}

async function columns(table: string): Promise<string[]> {
  const [schema, name] = table.split('.');

  const { rows } = await admin.query<{ column_name: string }>(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name',
    [schema, name],
  );

  return rows.map((row) => row.column_name);
}

async function failure(publishing: Promise<unknown>): Promise<ApiError> {
  const error = await publishing.then(
    () => new Error('The publish passed.'),
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ApiError);

  return error as ApiError;
}

function shape(error: ApiError): unknown[] {
  return [error.status, error.errorName, error.parameters];
}

// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- an asymmetric matcher stands in for a number in toEqual.
const MS = expect.any(Number) as unknown as number;

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

function faulting(inner: Db, fault: (text: string) => unknown): Db {
  return {
    query: (statement: Sql) => {
      const error = fault(statement.text);

      return error === undefined ? inner.query(statement) : Promise.reject(error);
    },
    stream: (statement) => inner.stream(statement),
    transaction: (run) => inner.transaction((tx) => run(faulting(tx, fault))),
    snapshot: (run) => inner.snapshot(run),
  };
}

const POSITIONS = [
  ['first', 0],
  ['middle', 1],
  ['last', 2],
] as const;

describe('the fault test: 3 installations, and 1 with data that fails its step in the transaction', () => {
  for (const [position, index] of POSITIONS) {
    it(`service/publish#applying service/publish#upgrade: when the ${position} installation fails, no version is stored, no installation moves, and the error names it`, async () => {
      const installed = await threeInstallations();

      const failing = installed[index];

      if (!failing) throw new Error('No installation at that position.');

      const error = await failure(
        publish(phaseRequired(), {
          between: async () =>
            void (await admin.query(`UPDATE ${failing.table} SET phase = NULL WHERE account_id = 'a1'`)),
        }),
      );

      expect(shape(error)).toEqual([
        400,
        'Default:InvalidArgument',
        {
          change: PHASE_REQUIRED,
          objectType: ACCOUNT,
          property: 'phase',
          badObjects: 1,
          primaryKeys: ['a1'],
          ontologyRid: failing.rid,
          transactionMs: MS,
        },
      ]);

      expect(Number.isInteger(error.parameters['transactionMs'])).toBe(true);

      expect(await versions()).toEqual([1]);

      expect(await registry()).toEqual([1, 1, 1]);

      expect(await phaseNullable(installed)).toEqual(['YES', 'YES', 'YES']);
    });
  }

  it('service/publish#applying: the check and the transaction give the same error for the same data, and only the error of the transaction has transactionMs', async () => {
    const [, middle] = await threeInstallations();

    if (!middle) throw new Error('No middle installation.');

    const nullPhase = async () =>
      void (await admin.query(`UPDATE ${middle.table} SET phase = NULL WHERE account_id = 'a1'`));

    const inTransaction = await failure(publish(phaseRequired(), { between: nullPhase }));

    const inCheck = await failure(publish(phaseRequired(), { mode: CHECK }));

    const inCheckOfApply = await failure(publish(phaseRequired()));

    const { transactionMs, ...rest } = inTransaction.parameters;

    expect(typeof transactionMs).toBe('number');

    const expected = [
      400,
      'Default:InvalidArgument',
      {
        change: PHASE_REQUIRED,
        objectType: ACCOUNT,
        property: 'phase',
        badObjects: 1,
        primaryKeys: ['a1'],
        ontologyRid: middle.rid,
      },
    ];

    expect([inTransaction.status, inTransaction.errorName, rest]).toEqual(expected);
    expect(shape(inCheck)).toEqual(expected);
    expect(shape(inCheckOfApply)).toEqual(expected);

    expect(await versions()).toEqual([1]);
  });

  it('service/publish#applying: the check holds no lock, so a change of a table of an installation does not wait while the check runs', async () => {
    const [first, middle] = await threeInstallations();

    if (!first || !middle) throw new Error('3 installations.');

    let altered = false;

    const checking: Db = {
      ...db,
      query: async (statement) => {
        if (!altered && statement.text.includes(`ontology_${middle.number}_objects`)) {
          altered = true;

          await admin.query("SET lock_timeout = '200ms'");

          await admin.query(`ALTER TABLE ${first.table} ADD COLUMN probe int`);

          await admin.query(`ALTER TABLE ${first.table} DROP COLUMN probe`);
        }

        return db.query(statement);
      },
    };

    expect((await publish(phaseRequired(), { mode: CHECK }, checking)).version).toBeUndefined();

    expect(altered).toBe(true);

    expect(await versions()).toEqual([1]);
  });
});

describe('a publish with good data', () => {
  it('service/publish#applying service/publish#upgrade service/publish#route: 1 commit stores the version and moves each installation, and the answer has version and transactionMs', async () => {
    const installed = await threeInstallations();

    const response = await publish(phaseRequired());

    expect(response.version).toBe(2);
    expect(Number.isInteger(response.transactionMs)).toBe(true);

    expect(await versions()).toEqual([1, 2]);

    expect(await registry()).toEqual([2, 2, 2]);

    expect(await phaseNullable(installed)).toEqual(['NO', 'NO', 'NO']);

    const { rows } = await admin.query<{ xid: string }>(
      `SELECT DISTINCT xid FROM (SELECT xmin::text AS xid FROM ${VERSIONS} WHERE version = 2 UNION ALL SELECT xmin::text FROM ${ONTOLOGIES}) AS writes`,
    );

    expect(rows).toHaveLength(1);
  });

  it('service/publish#applying: the transaction sets its limits 1 time, then locks the product versions, reads the newest version, sets the role defaults, locks each registry row in number order, inserts the version, and runs the steps', async () => {
    const installed = await threeInstallations();

    const statements: { text: string; values: readonly unknown[] }[] = [];

    const recording = (tx: Db): Db => ({
      ...tx,
      query: (statement) => {
        statements.push({
          text: statement.text.replace(/\s+/g, ' ').replaceAll('"', '').trim(),
          values: statement.values,
        });

        return tx.query(statement);
      },
    });

    await publish(phaseRequired(), { inTransaction: recording });

    const kinds = statements.map(({ text, values }) => {
      if (text.includes('set_config')) return `limits ${JSON.stringify(values)}`;

      if (text.startsWith('LOCK TABLE ontology_registry.product_versions')) return 'lock versions';

      if (text.startsWith('SELECT coalesce(max(version), 0)::int AS version FROM ontology_registry.product_versions'))
        return 'newest';

      if (text.startsWith('ALTER ROLE')) return 'role';

      if (text.includes('FOR UPDATE')) return `row ${JSON.stringify(values)}`;

      if (text.startsWith('INSERT INTO ontology_registry.product_versions')) return 'insert';

      if (text.startsWith('LOCK TABLE ontology_')) return `table ${text.split(' ')[2]}`;

      if (text.startsWith('ALTER TABLE')) return `alter ${text.split(' ')[2]}`;

      if (text.startsWith('UPDATE ontology_registry.ontologies')) return `move ${JSON.stringify(values)}`;

      return undefined;
    });

    const order = kinds.filter((kind) => kind !== undefined);
    const [first, middle, last] = installed;

    if (!first || !middle || !last) throw new Error('3 installations.');

    expect(order.slice(0, 10)).toEqual([
      'limits ["5s","60s"]',
      'lock versions',
      'newest',
      'role',
      'role',
      'role',
      'role',
      `row ["${first.rid}"]`,
      `row ["${middle.rid}"]`,
      `row ["${last.rid}"]`,
    ]);

    expect(order.filter((kind) => kind.startsWith('limits'))).toEqual(['limits ["5s","60s"]']);

    const after = order.filter((kind) => kind !== 'newest');

    expect(after.slice(after.indexOf(`row ["${last.rid}"]`))).toEqual([
      `row ["${last.rid}"]`,
      'insert',
      `table ${first.table}`,
      `alter ${first.table}`,
      `move ["${first.rid}"]`,
      `table ${middle.table}`,
      `alter ${middle.table}`,
      `move ["${middle.rid}"]`,
      `table ${last.table}`,
      `alter ${last.table}`,
      `move ["${last.rid}"]`,
    ]);
  });

  it('a publish that makes no new version inserts no product version and runs no step', async () => {
    await threeInstallations();

    const response = await publish(v1());

    expect(response.version).toBe(1);
    expect(Number.isInteger(response.transactionMs)).toBe(true);

    expect(await versions()).toEqual([1]);

    expect(await registry()).toEqual([1, 1, 1]);
  });
});

describe('a change between the check and the transaction', () => {
  it('service/publish#applying: a newer version stored after the check gives 409 PublishLockTimeout with phase version, and stores nothing', async () => {
    await threeInstallations();

    const error = await failure(
      publish(phaseRequired(), {
        between: async () => {
          await publish(withRegion());
        },
      }),
    );

    expect(shape(error)).toEqual([
      409,
      'PublishLockTimeout',
      { phase: 'version', table: VERSIONS, changed: false, transactionMs: MS },
    ]);

    expect(await versions()).toEqual([1, 2]);

    expect(await registry()).toEqual([2, 2, 2]);
  });

  it('service/publish#applying: an installation that is not on the newest version at the start of the transaction gives 500 with its RID, and stores nothing', async () => {
    const [, middle] = await threeInstallations();

    if (!middle) throw new Error('No middle installation.');

    await admin.query(
      `INSERT INTO ${VERSIONS} (product, version, ir, metadata, schema_migrations, osdk_set, grants, publisher) SELECT product, 0, ir, metadata, schema_migrations, osdk_set, grants, publisher FROM ${VERSIONS} WHERE version = 1`,
    );

    const error = await failure(
      publish(phaseRequired(), {
        between: async () =>
          void (await admin.query(`UPDATE ${ONTOLOGIES} SET version = 0 WHERE rid = $1`, [middle.rid])),
      }),
    );

    expect(shape(error)).toEqual([500, 'Default:Internal', { ontologyRid: middle.rid, transactionMs: MS }]);

    expect(await versions()).toEqual([0, 1]);

    expect(await registry()).toEqual([1, 0, 1]);

    await admin.query(`UPDATE ${ONTOLOGIES} SET version = 1 WHERE rid = $1`, [middle.rid]);
  });

  it('service/publish#install: an install that commits between the check and the transaction starts at the version before, and the transaction moves it', async () => {
    const installed = await threeInstallations();

    let late: Installed | undefined;

    const response = await publish(phaseRequired(), {
      between: async () => {
        late = await install('late', []);
      },
    });

    expect(response.version).toBe(2);

    if (!late) throw new Error('No late installation.');

    expect(await registry()).toEqual([2, 2, 2, 2]);

    expect(await phaseNullable([...installed, late])).toEqual(['NO', 'NO', 'NO', 'NO']);
  });
});

describe('an install and the transaction', () => {
  it('service/publish#install: an install during the transaction waits, then installs at the new version after the commit', async () => {
    const [, , last] = await threeInstallations();

    if (!last) throw new Error('No last installation.');

    const other = await holding(`LOCK TABLE ${last.table} IN ROW EXCLUSIVE MODE`);

    let installing: Promise<Installed> | undefined;

    try {
      const publishing = publish(phaseRequired());

      await waitForLockWaits(db, 1);

      installing = install('during', []);

      await waitForLockWaits(db, 2);

      await other.query('COMMIT');

      expect((await publishing).version).toBe(2);
    } finally {
      await release(other);
    }

    const during = await installing;

    expect(await registry()).toEqual([2, 2, 2, 2]);

    expect(await phaseNullable([during])).toEqual(['NO']);
  });

  it('service/publish#install: an install during the transaction waits, then installs at the version before after the rollback', async () => {
    const [, , last] = await threeInstallations();

    if (!last) throw new Error('No last installation.');

    const other = await holding(`LOCK TABLE ${last.table} IN ROW EXCLUSIVE MODE`);

    let installing: Promise<Installed> | undefined;

    try {
      const publishing = failure(publish(phaseRequired()));

      await waitForLockWaits(db, 1);

      installing = install('during', []);

      await waitForLockWaits(db, 2);

      await other.query(`UPDATE ${last.table} SET phase = NULL WHERE account_id = 'a1'`);

      await other.query('COMMIT');

      expect(shape(await publishing)).toEqual([
        400,
        'Default:InvalidArgument',
        {
          change: PHASE_REQUIRED,
          objectType: ACCOUNT,
          property: 'phase',
          badObjects: 1,
          primaryKeys: ['a1'],
          ontologyRid: last.rid,
          transactionMs: MS,
        },
      ]);
    } finally {
      await release(other);
    }

    const during = await installing;

    expect(await versions()).toEqual([1]);

    expect(await registry()).toEqual([1, 1, 1, 1]);

    expect(await phaseNullable([during])).toEqual(['YES']);
  });
});

describe('lock waits and the time limit', () => {
  it('service/publish#applying: while a second connection holds the registry row of the middle installation, the publish changes no table and gets 409 with its RID after 5 seconds', async () => {
    const installed = await threeInstallations();

    const [, middle] = installed;

    if (!middle) throw new Error('No middle installation.');

    const other = await holding(`SELECT 1 FROM ${ONTOLOGIES} WHERE rid = '${middle.rid}' FOR UPDATE`);

    try {
      const start = performance.now();

      const error = await failure(publish(phaseRequired()));

      expect(performance.now() - start).toBeGreaterThanOrEqual(4_900);

      expect(shape(error)).toEqual([
        409,
        'PublishLockTimeout',
        {
          phase: 'registry',
          table: ONTOLOGIES,
          changed: false,
          ontologyRid: middle.rid,
          change: 'lock',
          transactionMs: MS,
        },
      ]);
    } finally {
      await release(other);
    }

    expect(await versions()).toEqual([1]);

    expect(await registry()).toEqual([1, 1, 1]);

    expect(await phaseNullable(installed)).toEqual(['YES', 'YES', 'YES']);
  });

  it('service/publish#applying: a lock wait on a table of the last installation gives 409 with its RID and its table, and rolls back the first 2', async () => {
    const installed = await threeInstallations();

    const [, , last] = installed;

    if (!last) throw new Error('No last installation.');

    const other = await holding(`LOCK TABLE ${last.table} IN ROW EXCLUSIVE MODE`);

    try {
      const error = await failure(publish(phaseRequired()));

      expect(shape(error)).toEqual([
        409,
        'PublishLockTimeout',
        {
          phase: 'tableChanges',
          table: last.table,
          changed: false,
          ontologyRid: last.rid,
          change: 'lock',
          transactionMs: MS,
        },
      ]);
    } finally {
      await release(other);
    }

    expect(await versions()).toEqual([1]);

    expect(await registry()).toEqual([1, 1, 1]);

    expect(await phaseNullable(installed)).toEqual(['YES', 'YES', 'YES']);
  });

  it('service/publish#applying: the time limit of the transaction in the step of the middle installation gives 400 PublishTimeExceededLimit with its RID and change timeout', async () => {
    const installed = await threeInstallations();

    const [, middle] = installed;

    if (!middle) throw new Error('No middle installation.');

    const other = await holding(`LOCK TABLE ${middle.table} IN ROW EXCLUSIVE MODE`);

    try {
      const error = await failure(publish(phaseRequired(), { transactionTimeout: '1s' }));

      expect(shape(error)).toEqual([
        400,
        'PublishTimeExceededLimit',
        {
          phase: 'tableChanges',
          table: middle.table,
          changed: false,
          ontologyRid: middle.rid,
          change: 'timeout',
          transactionMs: MS,
        },
      ]);
    } finally {
      await release(other);
    }

    expect(await versions()).toEqual([1]);

    expect(await registry()).toEqual([1, 1, 1]);

    expect(await phaseNullable(installed)).toEqual(['YES', 'YES', 'YES']);
  });

  it('service/publish#applying: the engine-change catch-up of an installation waits for the open publish transaction, then runs', async () => {
    const [first, , last] = await threeInstallations();

    if (!first || !last) throw new Error('3 installations.');

    await admin.query(`DROP TABLE ontology_${first.number}_engine.edit_history`);

    await admin.query(`UPDATE ${ONTOLOGIES} SET engine_change_count = 1 WHERE rid = $1`, [first.rid]);

    const other = await holding(`LOCK TABLE ${last.table} IN ROW EXCLUSIVE MODE`);

    try {
      const publishing = publish(phaseRequired());

      await waitForLockWaits(db, 1);

      let caughtUp = false;
      const catchUp = applyEngineChanges(db).then(() => (caughtUp = true));

      await waitForLockWaits(db, 2);

      expect(caughtUp).toBe(false);

      await other.query('COMMIT');

      expect((await publishing).version).toBe(2);

      await catchUp;
    } finally {
      await release(other);
    }

    const { rows } = await admin.query<{ engine_change_count: number; version: number }>(
      `SELECT engine_change_count, version FROM ${ONTOLOGIES} WHERE rid = $1`,
      [first.rid],
    );

    expect(rows).toEqual([{ engine_change_count: 3, version: 2 }]);
  });

  it('service/publish#applying: at its statement limit, the catch-up during the open publish transaction fails, and changes nothing', async () => {
    const [first, , last] = await threeInstallations();

    if (!first || !last) throw new Error('3 installations.');

    await admin.query(`UPDATE ${ONTOLOGIES} SET engine_change_count = 1 WHERE rid = $1`, [first.rid]);

    const other = await holding(`LOCK TABLE ${last.table} IN ROW EXCLUSIVE MODE`);

    const limited = new pg.Client({ connectionString: serviceUrl, options: '-c statement_timeout=1s' });

    await limited.connect();

    try {
      const publishing = publish(phaseRequired());

      await waitForLockWaits(db, 1);

      const caught = await limited.query(`SELECT 1 FROM ${ONTOLOGIES} WHERE rid = '${first.rid}' FOR UPDATE`).then(
        () => 'locked',
        (error: { code?: string }) => error.code,
      );

      expect(caught).toBe('57014');

      await other.query('COMMIT');

      expect((await publishing).version).toBe(2);
    } finally {
      await limited.end();

      await release(other);
    }
  });
});

describe('the error of a step', () => {
  it('service/publish#applying service/publish#upgrade: a Postgres error on a statement of the step of the last installation gives 500 with postgresCode, its RID, and its change', async () => {
    const installed = await threeInstallations();

    const [, , last] = installed;

    if (!last) throw new Error('No last installation.');

    await admin.query(
      `CREATE FUNCTION refuse_alter() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN IF current_query() LIKE '%ontology_${last.number}_objects%' THEN RAISE EXCEPTION 'refused' USING ERRCODE = '23514'; END IF; END $$`,
    );

    await admin.query(
      `CREATE EVENT TRIGGER refuse_alter ON ddl_command_start WHEN TAG IN ('ALTER TABLE') EXECUTE FUNCTION refuse_alter()`,
    );

    const error = await failure(publish(phaseRequired()));

    expect(shape(error)).toEqual([
      500,
      'Default:Internal',
      { postgresCode: '23514', ontologyRid: last.rid, change: PHASE_REQUIRED, transactionMs: MS },
    ]);

    expect(await versions()).toEqual([1]);

    expect(await phaseNullable(installed)).toEqual(['YES', 'YES', 'YES']);
  });

  it('service/publish#upgrade service/publish#applying: a Postgres error on a plan read of the step of the middle installation gives 500 with postgresCode, its RID, and change check', async () => {
    const [, middle] = await threeInstallations();

    if (!middle) throw new Error('No middle installation.');

    const inTransaction = (tx: Db) =>
      faulting(tx, (text) =>
        text.startsWith('SELECT') && text.includes(`ontology_${middle.number}_objects`)
          ? Object.assign(new Error('refused'), { code: '22P02' })
          : undefined,
      );

    const error = await failure(publish(phaseRequired(), { inTransaction }));

    expect(shape(error)).toEqual([
      500,
      'Default:Internal',
      { postgresCode: '22P02', ontologyRid: middle.rid, change: 'check', transactionMs: MS },
    ]);

    expect(await versions()).toEqual([1]);
  });

  for (const [name, fault] of [
    ['08006 (Connection Exception)', { code: '08006' }],
    ['53100 (Insufficient Resources)', { code: '53100' }],
    ['57P01 (Operator Intervention)', { code: '57P01' }],
    ['58030 (System Error)', { code: '58030' }],
    ['XX000 (internal_error)', { code: 'XX000' }],
    ['ECONNRESET of Node, which is no SQLSTATE', { code: 'ECONNRESET' }],
    ['an error with no code', {}],
  ] as const) {
    it(`service/publish#applying: a fault of the database, ${name}, in the step of the middle installation gives 500 that names no installation, and rolls back all of it`, async () => {
      const installed = await threeInstallations();

      const [, middle] = installed;

      if (!middle) throw new Error('No middle installation.');

      const inTransaction = (tx: Db) =>
        faulting(tx, (text) =>
          text.startsWith('ALTER TABLE') && text.includes(`ontology_${middle.number}_objects`)
            ? Object.assign(new Error('fault'), fault)
            : undefined,
        );

      const error = await failure(publish(phaseRequired(), { inTransaction }));

      expect(shape(error)).toEqual([500, 'Default:Internal', { transactionMs: MS }]);

      expect(await versions()).toEqual([1]);

      expect(await registry()).toEqual([1, 1, 1]);

      expect(await phaseNullable(installed)).toEqual(['YES', 'YES', 'YES']);
    });
  }

  it('service/publish#applying: 57014 (a cancel) in class 57 is no fault of the database: the step of the middle installation gives 400 PublishTimeExceededLimit with its RID', async () => {
    const installed = await threeInstallations();

    const [, middle] = installed;

    if (!middle) throw new Error('No middle installation.');

    const inTransaction = (tx: Db) =>
      faulting(tx, (text) =>
        text.startsWith('ALTER TABLE') && text.includes(`ontology_${middle.number}_objects`)
          ? Object.assign(new Error('canceled'), { code: '57014' })
          : undefined,
      );

    const error = await failure(publish(phaseRequired(), { inTransaction }));

    expect(shape(error)).toEqual([
      400,
      'PublishTimeExceededLimit',
      {
        phase: 'tableChanges',
        table: middle.table,
        changed: false,
        ontologyRid: middle.rid,
        change: 'timeout',
        transactionMs: MS,
      },
    ]);

    expect(await versions()).toEqual([1]);

    expect(await registry()).toEqual([1, 1, 1]);
  });

  it('service/publish#applying: XX001 (data_corrupted) on a statement of the step of the middle installation is a failure on that installation', async () => {
    const [, middle] = await threeInstallations();

    if (!middle) throw new Error('No middle installation.');

    const inTransaction = (tx: Db) =>
      faulting(tx, (text) =>
        text.startsWith('ALTER TABLE') && text.includes(`ontology_${middle.number}_objects`)
          ? Object.assign(new Error('corrupt'), { code: 'XX001' })
          : undefined,
      );

    const error = await failure(publish(phaseRequired(), { inTransaction }));

    expect(shape(error)).toEqual([
      500,
      'Default:Internal',
      { postgresCode: 'XX001', ontologyRid: middle.rid, change: PHASE_REQUIRED, transactionMs: MS },
    ]);
  });

  it('service/publish#upgrade: a stored version that this release cannot compile fails the step of the first installation with change compile', async () => {
    const [first] = await threeInstallations();

    if (!first) throw new Error('No installation.');

    const uncompilable = { ...v1(), ontology: { ...v1().ontology, interfaceTypes: { [`${NS}Asset`]: {} } } };

    const error = await failure(
      publish(phaseRequired(), {
        between: async () =>
          void (await admin.query(`UPDATE ${VERSIONS} SET ir = $1::jsonb WHERE version = 1`, [
            JSON.stringify(uncompilable),
          ])),
      }),
    );

    expect(shape(error)).toEqual([
      400,
      'Default:InvalidArgument',
      {
        feature: `The IR has the Interface ${NS}Asset. V1 has no Interfaces.`,
        ontologyRid: first.rid,
        change: 'compile',
        transactionMs: MS,
      },
    ]);

    expect(await versions()).toEqual([1]);
  });

  it('service/publish#upgrade: the column limit check runs on the tables of each installation, and a table with no column left fails its step with the change on that table', async () => {
    const installed = await threeInstallations();

    const [, middle] = installed;

    if (!middle) throw new Error('No middle installation.');

    const fill = `DO $$ BEGIN FOR i IN 1..1596 LOOP EXECUTE format('ALTER TABLE ${middle.table} ADD COLUMN c%s int', i); EXECUTE format('ALTER TABLE ${middle.table} DROP COLUMN c%s', i); END LOOP; END $$`;

    const error = await failure(publish(withRegion(), { between: async () => void (await admin.query(fill)) }));

    expect([error.status, error.errorName, error.parameters['ontologyRid'], error.parameters['change']]).toEqual([
      400,
      'Default:InvalidArgument',
      middle.rid,
      `Create Property region of Object Type ${ACCOUNT}`,
    ]);

    expect(await versions()).toEqual([1]);

    expect(await columns(installed[0]?.table ?? '')).toEqual(['__version', 'account_id', 'name', 'phase']);
  });

  it('service/publish#upgrade: a check error of the step of the middle installation that names no table change gives change check, and the name and parameters of the check', async () => {
    const [, middle] = await threeInstallations();

    if (!middle) throw new Error('No middle installation.');

    const refusal = new ApiError(400, 'Default:InvalidArgument', { problem: 'refused' });

    const inTransaction = (tx: Db) =>
      faulting(tx, (text) =>
        text.startsWith('SELECT') && text.includes(`ontology_${middle.number}_objects`) ? refusal : undefined,
      );

    const error = await failure(publish(phaseRequired(), { inTransaction }));

    expect(shape(error)).toEqual([
      400,
      'Default:InvalidArgument',
      { problem: 'refused', ontologyRid: middle.rid, change: 'check', transactionMs: MS },
    ]);

    expect(await versions()).toEqual([1]);
  });
});

describe('the publish route', () => {
  const PATH = '/api/ontology-service/v1/publish';
  let issuer: TestIssuer;

  beforeAll(async () => {
    issuer = await createTestIssuer(testSettings.auth);
  });

  async function send(
    ir: OntologyIr,
    validateOnly: boolean,
    migrations: readonly SchemaMigration[] = [],
  ): Promise<{ status: number; body: Record<string, unknown>; log: Record<string, unknown> }> {
    const consoleLog = vi.spyOn(console, 'log');

    try {
      const body = {
        product: PRODUCT,
        ir,
        schemaMigrations: { migrations },
        osdkSet: OSDK_SET,
        grants: grantsOf(ir),
        validateOnly,
      };

      const request = new Request(`http://localhost${PATH}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await issuer.github()}` },
        body: JSON.stringify(body),
      });

      const response = await buffered(
        handle(request, {
          db: fallibleOf(db),
          directDb: fallibleOf(db),
          settings: testSettings,
          keys: issuer.keys,
          users: noUsers,
          workos: stubPublish(),
        }),
      );

      const lines = consoleLog.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('{'));
      const log = JSON.parse(lines.at(-1) ?? '{}') as { publish?: Record<string, unknown> };

      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
        log: log.publish ?? {},
      };
    } finally {
      consoleLog.mockRestore();
    }
  }

  it('service/publish#route service/observability#logs: the answer of an apply holds version and transactionMs as a whole number, and the request log holds transactionMs only for the apply', async () => {
    await threeInstallations();

    const checked = await send(phaseRequired(), true);

    expect([
      checked.status,
      'transactionMs' in checked.body,
      'transactionMs' in checked.log,
      checked.log['outcome'],
    ]).toEqual([200, false, false, 'validated']);

    const applied = await send(phaseRequired(), false);

    expect([
      applied.status,
      applied.body['version'],
      Number.isInteger(applied.body['transactionMs']),
      applied.log['outcome'],
      Number.isInteger(applied.log['transactionMs']),
    ]).toEqual([200, 2, true, 'applied', true]);

    expect(applied.log['transactionMs']).toBe(applied.body['transactionMs']);
  });

  it('service/observability#logs: a failed apply logs the transactionMs of its error, and a publish that fails before its transaction logs none', async () => {
    const [first] = await threeInstallations();

    if (!first) throw new Error('No installation.');

    await admin.query(`UPDATE ${first.table} SET phase = NULL WHERE account_id = 'a1'`);

    const inCheck = await send(phaseRequired(), false);

    expect([inCheck.status, 'transactionMs' in inCheck.log, inCheck.log['outcome']]).toEqual([400, false, 'failed']);

    const other = await holding(`LOCK TABLE ${first.table} IN ROW EXCLUSIVE MODE`);

    let inTransaction;

    try {
      inTransaction = await send(withRegion(), false);
    } finally {
      await release(other);
    }

    const parameters = inTransaction.body['parameters'] as Record<string, unknown>;

    expect([inTransaction.status, inTransaction.log['outcome'], inTransaction.log['transactionMs']]).toEqual([
      409,
      'failed',
      parameters['transactionMs'],
    ]);
  });

  it('service/observability#traces: a publish with a migration gives the read, plan, store, and lock wait spans, and its transaction gives 1 upgrade installation span with 1 upgrade step span for each installation, and each lock wait of an installation names its number', async () => {
    const installed = await threeInstallations();

    const move: SchemaMigration = { type: 'renameProperty', objectType: ACCOUNT, source: 'phase', target: 'stage' };

    const moved = account((block) => {
      const phase = block.objectType.propertyTypes['phase'];

      delete block.objectType.propertyTypes['phase'];

      if (phase) block.objectType.propertyTypes['stage'] = { ...phase, apiName: 'stage' };
    });

    expect((await send(moved, false, [move])).status).toBe(200);

    expect(await columns(installed[2]?.table ?? '')).toEqual(['__version', 'account_id', 'name', 'stage']);

    const spans = await routeSpans();

    const root = spans.filter((span) => span.name === `POST ${PATH}`).at(-1);
    const trace = spans.filter((span) => span.traceId === root?.traceId);

    const children = (parent: FinishedSpan | undefined): FinishedSpan[] =>
      trace.filter((span) => span.parentSpanId === parent?.spanId).sort((a, b) => (a.start < b.start ? -1 : 1));

    const named = (parent: FinishedSpan | undefined, names: readonly string[]) =>
      children(parent).filter((span) => names.includes(span.name));

    expect(named(root, ['publish read', 'publish plan', 'publish store']).map((span) => span.name)).toEqual([
      'publish read',
      'publish plan',
      'publish store',
    ]);

    const store = named(root, ['publish store'])[0];

    expect(named(store, ['lock wait', 'upgrade installation']).map((span) => span.name)).toEqual([
      'lock wait',
      'lock wait',
      'lock wait',
      'lock wait',
      'upgrade installation',
      'upgrade installation',
      'upgrade installation',
    ]);

    const rowWaits = named(store, ['lock wait'])
      .slice(1)
      .map((wait) => wait.attributes['ontology.number']);

    expect(rowWaits).toEqual([1, 2, 3]);

    const steps = named(store, ['upgrade installation']).map((installation) =>
      named(installation, ['upgrade step']).map((step) => [
        step.attributes['product.version'],
        named(step, ['lock wait']).map((wait) => wait.attributes['ontology.number']),
      ]),
    );

    expect(steps).toEqual([[[2, [1]]], [[2, [2]]], [[2, [3]]]]);
  });
});
