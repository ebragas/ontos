import type { OntologyIr, OntologyIrObjectTypeBlockDataV2 } from '@osdk/client.unstable';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db, type DbFailure, type Sql } from '../db/index.ts';
import { ApiError, invariant, type AsyncFallible } from '../errors/index.ts';

import type { PublishResponse, SchemaMigration } from './index.ts';
import { installIn, lockInstallation, lockProductVersions } from './install.ts';
import { publishOntology, type PublishMode } from './publishOntology.ts';
import { chainState } from './pure/upgradeErrors.ts';
import { runChain } from './upgrade.ts';
import { convertOrThrow, irOf, NS, twinObjectType } from '../ontology/stored.test-utils.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { TEST_ONTOLOGY_RID } from '../service.test-utils.ts';
import { ORGANIZATION } from '../tokens.test-utils.ts';
import {
  APPLY,
  CHECK,
  expectAllOnNewest,
  newDatabase,
  NO_GRANTS,
  OSDK_SET,
  PUBLISHER,
  rejecting,
  waitForLockWaits,
  type TestDatabase,
} from './publish.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const PRODUCT = 'twin';
const ONTOLOGIES = 'ontology_registry.ontologies';
const MOVE_PHASE: SchemaMigration = { type: 'renameProperty', objectType: ACCOUNT, source: 'phase', target: 'stage' };

let postgres: TestPostgres;
let database: TestDatabase;
let admin: pg.Client;
let pool: pg.Pool;
let db: Db;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  database = await newDatabase(postgres.url);

  admin = new pg.Client({ connectionString: database.url });

  await admin.connect();

  pool = createPool(database.url);

  db = createDb(pool);
});

afterEach(async () => {
  await expectAllOnNewest(database.db);

  await admin.end();

  await pool.end();

  await database.end();
});

type Rules = Readonly<Record<string, readonly string[]>>;

function withRules(block: OntologyIrObjectTypeBlockDataV2, rules: Rules): OntologyIrObjectTypeBlockDataV2 {
  for (const [name, properties] of Object.entries(rules)) {
    for (const apiName of properties) {
      const property = block.objectType.propertyTypes[apiName];

      if (!property) throw new Error(`The test block has no Property ${apiName}.`);

      property.typeClasses = [...property.typeClasses, { kind: 'unique', name }];
    }
  }

  return block;
}

function accountBlock(
  rules: Rules = {},
  change: (block: OntologyIrObjectTypeBlockDataV2) => void = () => undefined,
): OntologyIrObjectTypeBlockDataV2 {
  const block = twinObjectType('Account');
  const phase = block.objectType.propertyTypes['phase'];

  if (phase) phase.status = { type: 'experimental', experimental: {} };

  change(block);

  return withRules(block, rules);
}

function account(rules: Rules = {}, change?: (block: OntologyIrObjectTypeBlockDataV2) => void): OntologyIr {
  return irOf(accountBlock(rules, change));
}

function withRegion(block: OntologyIrObjectTypeBlockDataV2): void {
  const phase = block.objectType.propertyTypes['phase'];

  if (phase) block.objectType.propertyTypes['region'] = { ...structuredClone(phase), apiName: 'region' };
}

function phaseToStage(block: OntologyIrObjectTypeBlockDataV2): void {
  const phase = block.objectType.propertyTypes['phase'];

  delete block.objectType.propertyTypes['phase'];

  if (phase) block.objectType.propertyTypes['stage'] = { ...phase, apiName: 'stage' };
}

interface PublishOptions {
  readonly mode?: PublishMode;
  readonly migrations?: readonly SchemaMigration[];
  readonly between?: () => Promise<void>;
  readonly inTransaction?: (tx: Db) => Db;
}

function publish(ir: OntologyIr, options: PublishOptions = {}): Promise<PublishResponse> {
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
    ...db,
    transaction: async function* <T, E>(run: (tx: Db) => AsyncFallible<T, E>): AsyncFallible<T, E | DbFailure> {
      await options.between?.();

      return yield* db.transaction((tx) => run(options.inTransaction ? options.inTransaction(tx) : tx));
    },
  };

  const ontology = convertOrThrow({ ir, osdkSet: OSDK_SET, validateOnly }, TEST_ONTOLOGY_RID, 1);

  return rejecting(
    publishOntology(hooked, {
      product: PRODUCT,
      productRid: TEST_ONTOLOGY_RID,
      ontology,
      request,
      publisher: PUBLISHER,
      mode,
    }),
  );
}

async function store(version: number, ir: OntologyIr, migrations: readonly SchemaMigration[] = []): Promise<void> {
  const metadata = convertOrThrow({ ir, osdkSet: OSDK_SET, validateOnly: false }, TEST_ONTOLOGY_RID, version).metadata;

  await admin.query(
    `INSERT INTO ontology_registry.product_versions (product, version, ir, metadata, schema_migrations, osdk_set, functions, grants, publisher)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, NULL, $7::jsonb, 'test')`,
    [
      PRODUCT,
      version,
      JSON.stringify(ir),
      JSON.stringify(metadata),
      JSON.stringify({ migrations }),
      JSON.stringify(OSDK_SET),
      JSON.stringify(NO_GRANTS),
    ],
  );
}

interface Installed {
  readonly rid: string;
  readonly number: number;
  readonly table: string;
}

type Row = readonly [accountId: string, name: string, phase: string | null];

async function install(newest: OntologyIr, rows: readonly Row[] = []): Promise<Installed> {
  const rid = `ri.ontology.main.ontology.${crypto.randomUUID()}`;
  const compiled = convertOrThrow({ ir: newest, osdkSet: OSDK_SET, validateOnly: false }, TEST_ONTOLOGY_RID, 1);
  const input = { rid, product: PRODUCT, apiName: 'twin', displayName: 'twin', organization: ORGANIZATION };

  await rejecting(
    db.transaction(async function* (tx): AsyncFallible<unknown, unknown> {
      return yield* installIn(tx, yield* lockProductVersions(tx), input, compiled);
    }),
  );

  const { rows: found } = await admin.query<{ number: number }>(`SELECT number FROM ${ONTOLOGIES} WHERE rid = $1`, [
    rid,
  ]);

  const number = found[0]?.number ?? 0;
  const installed = { rid, number, table: `ontology_${number}_objects.account` };

  await insert(installed, rows);

  return installed;
}

async function insert(installed: Installed, rows: readonly Row[], client: pg.Client = admin): Promise<void> {
  for (const [accountId, name, phase] of rows) {
    await client.query(`INSERT INTO ${installed.table} (account_id, name, phase) VALUES ($1, $2, $3)`, [
      accountId,
      name,
      phase,
    ]);
  }
}

async function installed(ir: OntologyIr, rows: readonly Row[] = []): Promise<Installed> {
  await publish(ir);

  return install(ir, rows);
}

function constraintName(table: string, rule: string): string {
  const base = Buffer.from(`unique_${table}_${rule}`).subarray(0, 54).toString();

  return `${base}_${createHash('sha1').update(`unique:${table}:${rule}`).digest('hex').slice(0, 8)}`;
}

async function constraints(table: string): Promise<Record<string, string>> {
  const { rows } = await admin.query<{ name: string; definition: string }>(
    "SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = 'u' ORDER BY conname",
    [table],
  );

  return Object.fromEntries(rows.map((row) => [row.name, row.definition]));
}

async function versions(): Promise<number[]> {
  return (
    await admin.query<{ version: number }>('SELECT version FROM ontology_registry.product_versions ORDER BY version')
  ).rows.map((row) => row.version);
}

async function failure(publishing: Promise<unknown>): Promise<ApiError> {
  const error = await publishing.then(
    () => new Error('The publish passed.'),
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ApiError);

  return error as ApiError;
}

function descriptions(response: PublishResponse): string[] {
  return response.changes.map((change) => change.description);
}

function shape(error: ApiError): unknown[] {
  return [error.status, error.errorName, error.parameters];
}

async function expectRefused(
  ir: OntologyIr,
  installation: Installed,
  parameters: Record<string, unknown>,
  migrations: readonly SchemaMigration[] = [],
): Promise<void> {
  const [before, stored] = [await constraints(installation.table), await versions()];

  for (const mode of [CHECK, APPLY]) {
    expect(shape(await failure(publish(ir, { mode, migrations })))).toEqual([
      400,
      'Default:InvalidArgument',
      { ...parameters, ontologyRid: installation.rid },
    ]);
  }

  expect(await constraints(installation.table)).toEqual(before);

  expect(await versions()).toEqual(stored);
}

async function* failed(error: Error): AsyncFallible<never, DbFailure> {
  return yield { kind: 'unavailable', error };
}

function faulting(inner: Db, matches: (text: string) => boolean, fault: Error): Db {
  return {
    query: <Row extends object>(statement: Sql) =>
      matches(statement.text) ? failed(fault) : inner.query<Row>(statement),
    stream: <Row extends object>(statement: Sql) => inner.stream<Row>(statement),
    transaction: <T, E>(run: (tx: Db) => AsyncFallible<T, E>) =>
      inner.transaction((tx) => run(faulting(tx, matches, fault))),
    snapshot: (run) => inner.snapshot(run),
  };
}

const CREATE_BY_NAME = `Create Uniqueness constraint byName of Object Type ${ACCOUNT}`;
const CREATE_PAIR = `Create Uniqueness constraint pair of Object Type ${ACCOUNT}`;

const CLASHING: readonly Row[] = [
  ['a1', 'Acme', 'lead'],
  ['a2', 'Acme', 'won'],
  ['a3', 'Bolt', 'lead'],
];

describe('the constraint of a rule', () => {
  it('service/storage#indexes: a new Object Type with rules gets 1 deferred unique constraint per rule, named by the rule, and 2 Object Types with 1 rule name get 2 names', async () => {
    const engagement = withRules(twinObjectType('Engagement'), { byName: ['title'] });

    const { table, number } = await installed(
      irOf(accountBlock({ byName: ['name'], pair: ['phase', 'name'] }), engagement),
    );

    expect(await constraints(table)).toEqual({
      [constraintName('account', 'byName')]: 'UNIQUE (name) DEFERRABLE INITIALLY DEFERRED',
      [constraintName('account', 'pair')]: 'UNIQUE (name, phase) DEFERRABLE INITIALLY DEFERRED',
    });

    expect(await constraints(`ontology_${number}_objects.engagement`)).toEqual({
      [constraintName('engagement', 'byName')]: 'UNIQUE (title) DEFERRABLE INITIALLY DEFERRED',
    });

    expect(constraintName('account', 'byName')).not.toBe(constraintName('engagement', 'byName'));
    expect(constraintName('account', 'byName')).toMatch(/^unique_account_byName_[0-9a-f]{8}$/);
  });

  it('service/storage#indexes: a rule name that makes a name over 54 bytes is cut to 54 bytes before the hash, and fits 63 bytes', async () => {
    const rule = 'theNumberOfTheInvoiceThatTheBankSentForThisAccountInTheFeed';

    const { table } = await installed(account({ [rule]: ['name'] }));

    const name = constraintName('account', rule);

    expect(name).toHaveLength(63);

    expect(await constraints(table)).toEqual({ [name]: 'UNIQUE (name) DEFERRABLE INITIALLY DEFERRED' });
  });
});

describe('the stored-data checks of a new rule', () => {
  it('ontology/object-edits/schema-migrations#stored-data-checks: a new rule on stored values fails while 2 Objects clash, in the check and in the apply, and writes nothing', async () => {
    const installation = await installed(account(), CLASHING);

    await expectRefused(account({ byName: ['name'] }), installation, {
      change: CREATE_BY_NAME,
      objectType: ACCOUNT,
      property: 'name',
      badObjects: 2,
      primaryKeys: ['a1', 'a2'],
    });

    expect(await constraints(installation.table)).toEqual({});
  });

  it('ontology/object-edits/schema-migrations#stored-data-checks: 12 clashing Objects give badObjects 12 and the first 10 keys in primary key order, and a rule on 2 Properties names no property', async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `a${String(i + 1).padStart(2, '0')}`);

    const installation = await installed(
      account(),
      [...keys].reverse().map((key): Row => [key, 'Acme', 'lead']),
    );

    await expectRefused(account({ pair: ['name', 'phase'] }), installation, {
      change: CREATE_PAIR,
      objectType: ACCOUNT,
      badObjects: 12,
      primaryKeys: keys.slice(0, 10),
    });
  });

  it('ontology/object-edits/schema-migrations#stored-data-checks: an Object with no value in 1 Property of a rule never clashes, so the publish adds the constraint', async () => {
    const installation = await installed(account(), [
      ['a1', 'Acme', null],
      ['a2', 'Acme', null],
      ['a3', 'Bolt', 'lead'],
    ]);

    const response = await publish(account({ pair: ['name', 'phase'] }));

    expect(descriptions(response)).toEqual([CREATE_PAIR]);

    expect(await constraints(installation.table)).toEqual({
      [constraintName('account', 'pair')]: 'UNIQUE (name, phase) DEFERRABLE INITIALLY DEFERRED',
    });
  });

  it('ontology/object-edits/schema-migrations#stored-data-checks: a new rule fails while a stored String has more than 500 UTF-8 bytes, and only those Objects count; 500 bytes pass', async () => {
    const long = `${'é'.repeat(250)}a`;

    const installation = await installed(account(), [
      ...CLASHING,
      ['a4', long, 'lead'],
      ['a5', 'é'.repeat(250), 'lead'],
    ]);

    await expectRefused(account({ byName: ['name'] }), installation, {
      change: CREATE_BY_NAME,
      objectType: ACCOUNT,
      property: 'name',
      badObjects: 1,
      primaryKeys: ['a4'],
    });

    await admin.query(`DELETE FROM ${installation.table} WHERE account_id IN ('a2', 'a4')`);

    await publish(account({ byName: ['name'] }));

    expect(Object.keys(await constraints(installation.table))).toEqual([constraintName('account', 'byName')]);
  });

  it('service/publish#applying: a write that commits before the publish locks the table is checked under the lock, so a clash fails the publish with transactionMs', async () => {
    const installation = await installed(account(), [['a1', 'Acme', 'lead']]);

    const other = new pg.Client({ connectionString: database.url });

    await other.connect();

    try {
      await other.query('BEGIN');

      await insert(installation, [['a2', 'Acme', 'won']], other);

      const running = failure(publish(account({ byName: ['name'] })));

      await waitForLockWaits(database.db, 1);

      await other.query('COMMIT');

      const error = await running;

      expect(shape(error)).toEqual([
        400,
        'Default:InvalidArgument',
        {
          change: CREATE_BY_NAME,
          objectType: ACCOUNT,
          property: 'name',
          badObjects: 2,
          primaryKeys: ['a1', 'a2'],
          ontologyRid: installation.rid,
          transactionMs: expect.any(Number),
        },
      ]);
    } finally {
      await other.end();
    }

    expect(await constraints(installation.table)).toEqual({});

    expect(await versions()).toEqual([1]);
  });

  it('service/publish#applying: a database fault in the clash check gives 500 and writes nothing, and the same publish then applies', async () => {
    const installation = await installed(account(), [['a1', 'Acme', 'lead']]);

    const fault = Object.assign(new Error('connection lost'), { code: '08006' });
    const inTransaction = (tx: Db) => faulting(tx, (text) => text.includes('OVER (PARTITION BY'), fault);

    expect(shape(await failure(publish(account({ byName: ['name'] }), { inTransaction })))).toEqual([
      500,
      'Default:Internal',
      { transactionMs: expect.any(Number) },
    ]);

    expect(await constraints(installation.table)).toEqual({});

    expect(await versions()).toEqual([1]);

    await publish(account({ byName: ['name'] }));

    expect(Object.keys(await constraints(installation.table))).toEqual([constraintName('account', 'byName')]);
  });
});

describe('a changed or removed rule', () => {
  it('ontology/object-edits/schema-migrations#stored-data-checks: a publish that removes a rule passes with no check, and drops its constraint', async () => {
    const installation = await installed(account({ byName: ['name'] }), [['a1', 'Acme', 'lead']]);

    const response = await publish(account());

    expect(descriptions(response)).toEqual([`Delete Uniqueness constraint byName of Object Type ${ACCOUNT}`]);

    expect(await constraints(installation.table)).toEqual({});
  });

  it('ontology/object-edits/schema-migrations#stored-data-checks: a renamed rule drops the old constraint and adds the new one, with the checks of a new rule', async () => {
    const installation = await installed(account({ byName: ['name'] }), [['a1', 'Acme', 'lead']]);

    await admin.query(`ALTER TABLE ${installation.table} DROP CONSTRAINT "${constraintName('account', 'byName')}"`);

    await insert(installation, [['a2', 'Acme', 'won']]);

    const create = `Create Uniqueness constraint theName of Object Type ${ACCOUNT}`;

    await expectRefused(account({ theName: ['name'] }), installation, {
      change: create,
      objectType: ACCOUNT,
      property: 'name',
      badObjects: 2,
      primaryKeys: ['a1', 'a2'],
    });

    await admin.query(`DELETE FROM ${installation.table} WHERE account_id = 'a2'`);

    const response = await publish(account({ theName: ['name'] }));

    expect(descriptions(response)).toEqual([`Delete Uniqueness constraint byName of Object Type ${ACCOUNT}`, create]);

    expect(await constraints(installation.table)).toEqual({
      [constraintName('account', 'theName')]: 'UNIQUE (name) DEFERRABLE INITIALLY DEFERRED',
    });
  });

  it('ontology/object-edits/schema-migrations#stored-data-checks: a rule whose Properties change under 1 name drops its constraint first, checks the new Properties, and adds the constraint again with the same name', async () => {
    const installation = await installed(account({ pair: ['name', 'phase'] }), CLASHING);

    await expectRefused(account({ pair: ['name'] }), installation, {
      change: CREATE_PAIR,
      objectType: ACCOUNT,
      property: 'name',
      badObjects: 2,
      primaryKeys: ['a1', 'a2'],
    });

    expect(await constraints(installation.table)).toEqual({
      [constraintName('account', 'pair')]: 'UNIQUE (name, phase) DEFERRABLE INITIALLY DEFERRED',
    });

    await admin.query(`UPDATE ${installation.table} SET name = 'Acme 2' WHERE account_id = 'a2'`);

    const response = await publish(account({ pair: ['name'] }));

    expect(descriptions(response)).toEqual([
      `Delete Uniqueness constraint pair of Object Type ${ACCOUNT}`,
      CREATE_PAIR,
    ]);

    expect(await constraints(installation.table)).toEqual({
      [constraintName('account', 'pair')]: 'UNIQUE (name) DEFERRABLE INITIALLY DEFERRED',
    });
  });

  it('principle make-operations-idempotent, service/publish#applying: a fault between the Delete and the Create rolls back both, and the same publish then reaches the end state', async () => {
    const installation = await installed(account({ pair: ['name', 'phase'] }), [['a1', 'Acme', 'lead']]);

    const fault = Object.assign(new Error('connection lost'), { code: '08006' });
    const inTransaction = (tx: Db) => faulting(tx, (text) => text.includes('ADD CONSTRAINT'), fault);

    expect(shape(await failure(publish(account({ pair: ['name'] }), { inTransaction })))).toEqual([
      500,
      'Default:Internal',
      { transactionMs: expect.any(Number) },
    ]);

    expect(await constraints(installation.table)).toEqual({
      [constraintName('account', 'pair')]: 'UNIQUE (name, phase) DEFERRABLE INITIALLY DEFERRED',
    });

    expect(await versions()).toEqual([1]);

    await publish(account({ pair: ['name'] }));

    expect(await constraints(installation.table)).toEqual({
      [constraintName('account', 'pair')]: 'UNIQUE (name) DEFERRABLE INITIALLY DEFERRED',
    });

    expect(await versions()).toEqual([1, 2]);
  });

  it('ontology/object-edits/schema-migrations#stored-data-checks service/publish#applying: a rule of the stored version with no constraint in Postgres gets it at the next publish, with the checks', async () => {
    const installation = await installed(account({ byName: ['name'] }), [['a1', 'Acme', 'lead']]);

    await admin.query(`ALTER TABLE ${installation.table} DROP CONSTRAINT "${constraintName('account', 'byName')}"`);

    await insert(installation, [['a2', 'Acme', 'won']]);

    const next = account({ byName: ['name'] }, withRegion);

    await expectRefused(next, installation, {
      change: CREATE_BY_NAME,
      objectType: ACCOUNT,
      property: 'name',
      badObjects: 2,
      primaryKeys: ['a1', 'a2'],
    });

    await admin.query(`DELETE FROM ${installation.table} WHERE account_id = 'a2'`);

    await publish(next);

    expect(await constraints(installation.table)).toEqual({
      [constraintName('account', 'byName')]: 'UNIQUE (name) DEFERRABLE INITIALLY DEFERRED',
    });
  });

  it('ontology/object-edits/schema-migrations#stored-data-checks: a publish with no installation plans no change for a rule that did not change, in the check and in the apply', async () => {
    await publish(account({ byName: ['name'] }));

    const next = account({ byName: ['name'] }, withRegion);

    expect(descriptions(await publish(next, { mode: CHECK }))).toEqual([
      `Create Property region of Object Type ${ACCOUNT}`,
    ]);

    expect(descriptions(await publish(next))).toEqual([`Create Property region of Object Type ${ACCOUNT}`]);
  });
});

describe('a rule and the changes of its Properties', () => {
  it('ontology/object-edits/schema-migrations#stored-data-checks: a Move of a Property of a rule keeps the constraint and its name, with no check', async () => {
    const installation = await installed(account({ byPhase: ['phase'] }), CLASHING.slice(1));

    const response = await publish(account({ byPhase: ['stage'] }, phaseToStage), { migrations: [MOVE_PHASE] });

    expect(descriptions(response)).toEqual([`Move Property phase to stage of Object Type ${ACCOUNT}`]);

    expect(await constraints(installation.table)).toEqual({
      [constraintName('account', 'byPhase')]: 'UNIQUE (stage) DEFERRABLE INITIALLY DEFERRED',
    });
  });

  it('ontology/object-edits/schema-migrations#stored-data-checks: a Move into a rule checks the values of the old Property, and names it', async () => {
    const installation = await installed(account(), CLASHING);

    const moved = account({ byStage: ['stage'] }, phaseToStage);
    const create = `Create Uniqueness constraint byStage of Object Type ${ACCOUNT}`;

    await expectRefused(
      moved,
      installation,
      { change: create, objectType: ACCOUNT, property: 'phase', badObjects: 2, primaryKeys: ['a1', 'a3'] },
      [MOVE_PHASE],
    );

    await admin.query(`UPDATE ${installation.table} SET phase = 'lost' WHERE account_id = 'a3'`);

    await publish(moved, { migrations: [MOVE_PHASE] });

    expect(await constraints(installation.table)).toEqual({
      [constraintName('account', 'byStage')]: 'UNIQUE (stage) DEFERRABLE INITIALLY DEFERRED',
    });
  });

  it('ontology/object-edits/schema-migrations#stored-data-checks: a Drop of 1 Property of a rule of 2 adds the rule again on the other Property, with the checks', async () => {
    const installation = await installed(account({ pair: ['name', 'phase'] }), CLASHING);

    const dropped = account({ pair: ['name'] }, (block) => void delete block.objectType.propertyTypes['phase']);
    const drop: SchemaMigration = { type: 'dropProperty', objectType: ACCOUNT, property: 'phase' };

    await expectRefused(
      dropped,
      installation,
      { change: CREATE_PAIR, objectType: ACCOUNT, property: 'name', badObjects: 2, primaryKeys: ['a1', 'a2'] },
      [drop],
    );

    await admin.query(`DELETE FROM ${installation.table} WHERE account_id = 'a2'`);

    await publish(dropped, { migrations: [drop] });

    expect(await constraints(installation.table)).toEqual({
      [constraintName('account', 'pair')]: 'UNIQUE (name) DEFERRABLE INITIALLY DEFERRED',
    });
  });

  it('ontology/object-edits/schema-migrations#stored-data-checks: a new Property in a rule runs no check, because its column holds no value', async () => {
    const installation = await installed(account(), CLASHING);

    await publish(account({ pair: ['name', 'region'] }, withRegion));

    expect(await constraints(installation.table)).toEqual({
      [constraintName('account', 'pair')]: 'UNIQUE (name, region) DEFERRABLE INITIALLY DEFERRED',
    });
  });

  it('ontology/object-edits/schema-migrations#stored-data-checks: a base type change of a Property in a rule runs no check, and the rule gets its constraint on the new column', async () => {
    const installation = await installed(account({ pair: ['name', 'phase'] }), [
      ...CLASHING,
      ['a4', `${'é'.repeat(250)}a`, 'lead'],
    ]);

    const integerPhase = account({ pair: ['name', 'phase'] }, (block) => {
      const phase = block.objectType.propertyTypes['phase'];

      if (phase) phase.type = { type: 'integer', integer: {} };
    });

    await publish(integerPhase, { migrations: [{ type: 'dropProperty', objectType: ACCOUNT, property: 'phase' }] });

    expect(await constraints(installation.table)).toEqual({
      [constraintName('account', 'pair')]: 'UNIQUE (name, phase) DEFERRABLE INITIALLY DEFERRED',
    });
  });

  it('ontology/object-edits/schema-migrations#stored-data-checks: a Drop of all Objects runs no check of a new rule', async () => {
    const installation = await installed(account(), CLASHING);

    const newKey = account({ byPhase: ['phase'] }, (block) => void (block.objectType.primaryKeys = ['name']));

    await publish(newKey, { migrations: [{ type: 'dropAllPatches', objectType: ACCOUNT }] });

    expect(await constraints(installation.table)).toEqual({
      [constraintName('account', 'byPhase')]: 'UNIQUE (phase) DEFERRABLE INITIALLY DEFERRED',
    });
  });
});

describe('the chain', () => {
  it('service/publish#applying service/publish#upgrade: a chain of 2 steps, where step 1 adds a rule and step 2 moves its Property, ends with the constraint', async () => {
    await store(1, account());

    const installation = await install(account(), CLASHING.slice(1));

    await store(2, account({ byPhase: ['phase'] }));

    await store(3, account({ byPhase: ['stage'] }, phaseToStage), [MOVE_PHASE]);

    await rejecting(
      db.transaction(async function* (tx): AsyncFallible<unknown, unknown> {
        const locked = yield* lockInstallation(tx, installation.rid);

        invariant(locked, `No registry row ${installation.rid}.`);

        return yield* runChain(tx, locked, chainState());
      }),
    );

    expect(await constraints(installation.table)).toEqual({
      [constraintName('account', 'byPhase')]: 'UNIQUE (stage) DEFERRABLE INITIALLY DEFERRED',
    });
  });
});
