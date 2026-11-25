import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { workosPublish } from '../auth/index.ts';
import { createPool, type Sql } from '../db/index.ts';
import { createDb, type Db } from '../db/promise.test-utils.ts';
import type { GrantsFile } from '../ontology/index.ts';

import type { CheckedRequest, PublishResponse, WorkosPort } from './index.ts';
import { installOntology } from '../install.test-utils.ts';
import { convertOrThrow, irOf, NS, twinObjectType } from '../ontology/stored.test-utils.ts';
import { createEngineTemplate, startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { TEST_ONTOLOGY_RID } from '../service.test-utils.ts';
import { ORGANIZATION } from '../tokens.test-utils.ts';
import { failingWith, STUB_PERSON, STUB_WORKOS_KEY, stubWorkos, type StubWorkos } from '../workos.test-utils.ts';
import { outsideFailure } from '../errors/index.ts';
import { APPLY, expectAllOnNewest, OSDK_SET, PUBLISHER, publishOntology } from './publish.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const PRODUCT = 'twin';
const VERSIONS = 'ontology_registry.product_versions';
const SERVICE_PASSWORD = 'model-paths';

let postgres: TestPostgres;
let serviceRole: string;
let template: string;
let databases = 0;
let admin: pg.Client;
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
  const name = `${postgres.role}_paths_${++databases}`;

  await onAdmin(postgres.url, `CREATE DATABASE ${name} TEMPLATE ${template}`);

  await onAdmin(postgres.url, `GRANT CREATE ON DATABASE ${name} TO ${serviceRole}`);

  const url = new URL(postgres.url);

  url.pathname = `/${name}`;

  admin = new pg.Client({ connectionString: url.toString() });

  await admin.connect();

  url.username = serviceRole;
  url.password = SERVICE_PASSWORD;

  pool = createPool(url.toString());

  db = createDb(pool);

  await db.query({ text: 'ALTER ROLE CURRENT_USER RESET ALL', values: [] });
});

afterEach(async () => {
  try {
    await expectAllOnNewest(db);
  } finally {
    await Promise.allSettled([admin.end(), pool.end()]);
  }
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

const IR = irOf(twinObjectType('Account'));

function grants(roles: Readonly<Record<string, readonly string[]>>): GrantsFile {
  const slugs = [...new Set(Object.values(roles).flat())].sort();

  return {
    permissions: Object.fromEntries(slugs.map((slug) => [slug, { description: `Use ${slug}` }])),
    objectTypes: { [ACCOUNT]: 'a' },
    actionTypes: {},
    defaultRoles: roles,
  };
}

const FA = grants({ r1: ['p1'] });
const FB = grants({ r1: ['p2'], r2: ['p1'] });

function publish(file: GrantsFile, port: WorkosPort, on: Db = db): Promise<PublishResponse> {
  const request = {
    product: PRODUCT,
    ir: JSON.parse(JSON.stringify(IR)),
    schemaMigrations: { migrations: [] },
    osdkSet: OSDK_SET,
    grants: file,
    validateOnly: false,
  };

  return publishOntology(on, {
    product: PRODUCT,
    productRid: TEST_ONTOLOGY_RID,
    ontology: convertOrThrow({ ir: IR, osdkSet: OSDK_SET, validateOnly: false }, TEST_ONTOLOGY_RID, 1),
    request: request as CheckedRequest,
    publisher: PUBLISHER,
    mode: APPLY,
    workos: port,
  });
}

function newStub(roles: Readonly<Record<string, readonly string[]>> = {}): StubWorkos {
  return stubWorkos(
    [STUB_PERSON],
    [{ user_id: STUB_PERSON.id, organization_id: ORGANIZATION, status: 'active', roles: ['member'] }],
    {
      roles: {},
      environment: { permissions: {}, roles },
    },
  );
}

const portOf = (stub: StubWorkos): WorkosPort => workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch });

const stoppedCall = () => failingWith(outsideFailure(new Error('The request stopped.')));

function roles(stub: StubWorkos): Record<string, string[]> {
  return Object.fromEntries(Object.entries(stub.environment().roles).map(([slug, held]) => [slug, [...held].sort()]));
}

async function versions(): Promise<number[]> {
  return (await admin.query<{ version: number }>(`SELECT version FROM ${VERSIONS} ORDER BY version`)).rows.map(
    (row) => row.version,
  );
}

interface Thrown {
  readonly status?: number;
  readonly errorName?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

async function failure(call: Promise<unknown>): Promise<Thrown> {
  return (await call.then(
    () => ({ errorName: 'The call passed.' }),
    (error: unknown) => error,
  )) as Thrown;
}

function gate(): { readonly open: () => void; readonly opened: Promise<undefined> } {
  const { promise, resolve } = Promise.withResolvers<undefined>();

  return { open: () => resolve(undefined), opened: promise };
}

function connectionEnded(): Error {
  return new Error('Connection terminated unexpectedly');
}

const isGrantsRead = (text: string): boolean => text.startsWith(`SELECT grants FROM ${VERSIONS}`);

describe('rule 2b: a job reports a failure for a stored version (known case 2)', () => {
  it('path WorkOS.1: the first publish commits, and the request stops before the reconcile', async () => {
    const stub = newStub();
    const live = portOf(stub);
    let committed = false;

    const hooked: Db = {
      ...db,
      transaction: async (run) => {
        const result = await db.transaction(run);

        committed = true;

        return result;
      },
    };

    const stopping: WorkosPort = {
      read: () => (committed ? stoppedCall() : live.read()),
      memberRoles: () => live.memberRoles(),
      apply: (step) => live.apply(step),
      setPermissions: () => stoppedCall(),
    };

    const error = await failure(publish(FA, stopping, hooked));

    expect([error.status, error.errorName, await versions(), roles(stub)]).toEqual([500, 'Default:Internal', [1], {}]);

    const rerun = await publish(FA, live);

    expect([rerun.version, await versions(), roles(stub)]).toEqual([1, [1], { r1: ['p1'] }]);
  });

  it('service/publish#applying: path WorkOS.1b: the answer to COMMIT is lost after Postgres committed, the reconcile reads the new version, and the publish answers 500', async () => {
    const stub = newStub();

    const lost: Db = {
      ...db,
      transaction: async (run) => {
        await db.transaction(run);

        throw connectionEnded();
      },
    };

    const error = await failure(publish(FA, portOf(stub), lost));

    expect([
      error.status,
      error.errorName,
      typeof error.parameters?.['transactionMs'],
      await versions(),
      roles(stub),
    ]).toEqual([500, 'Default:Internal', 'number', [1], { r1: ['p1'] }]);

    const rerun = await publish(FA, portOf(stub));

    expect([rerun.version, await versions()]).toEqual([1, [1]]);
  });
});

describe('rule 5 as first worded: a reconcile that passed leaves the roles on an older file (known case 2)', () => {
  function lateCommit(): Db {
    const commit = gate();
    let pending: Promise<unknown> | undefined;

    return {
      ...db,
      transaction: (run) =>
        new Promise<never>((_resolve, reject) => {
          pending = db.transaction(async (tx) => {
            const result = await run(tx);

            reject(connectionEnded());

            await commit.opened;

            return result;
          });
        }),
      query: async <Row extends object>(sql: Sql) => {
        const rows = await db.query<Row>(sql);

        if (pending && isGrantsRead(sql.text)) {
          commit.open();

          await pending;
        }

        return rows;
      },
    };
  }

  it('path WorkOS.2 after version 1: until the rerun, r1 keeps p1, which version 2 drops, and lacks p2, which version 2 adds', async () => {
    const stub = newStub();

    await publish(FA, portOf(stub));

    const error = await failure(publish(FB, portOf(stub), lateCommit()));

    expect([error.status, error.errorName, await versions(), roles(stub)]).toEqual([
      500,
      'Default:Internal',
      [1, 2],
      { r1: ['p1'] },
    ]);

    const rerun = await publish(FB, portOf(stub));

    expect([rerun.version, await versions(), roles(stub)]).toEqual([2, [1, 2], { r1: ['p2'], r2: ['p1'] }]);
  });

  it('path WorkOS.2: the first publish: the answer to COMMIT is lost, the reconcile reads no version, then Postgres commits', async () => {
    const stub = newStub();

    const error = await failure(publish(FA, portOf(stub), lateCommit()));

    expect([error.status, error.errorName, await versions(), roles(stub)]).toEqual([500, 'Default:Internal', [1], {}]);

    const rerun = await publish(FA, portOf(stub));

    expect([rerun.version, await versions(), roles(stub)]).toEqual([1, [1], { r1: ['p1'] }]);
  });
});

describe('2 publishes of 1 environment at one time (known case 1): a canceled job whose request still runs', () => {
  async function installed(): Promise<void> {
    await installOntology(db, {
      rid: `ri.ontology.main.ontology.${crypto.randomUUID()}`,
      product: PRODUCT,
      apiName: 'first',
      displayName: 'first',
      organization: ORGANIZATION,
    });
  }

  function heldPort(stub: StubWorkos, go: Promise<undefined>, reached: () => void): WorkosPort {
    const live = portOf(stub);

    return {
      read: () => live.read(),
      memberRoles: () => live.memberRoles(),
      apply: async function* (step): ReturnType<WorkosPort['apply']> {
        reached();

        await go;

        return yield* live.apply(step);
      },
      setPermissions: (role, permissions) => live.setPermissions(role, permissions),
    };
  }

  it('path Ghost.5 (rule 7), service part: request B answers version 1 while request A stores version 2; packages/cli/src/publishModelPath.sql.test.ts replays the release', async () => {
    const stub = newStub();

    await publish(FA, portOf(stub));

    await installed();

    const go = gate();
    const atAdds = gate();
    const a = publish(FB, heldPort(stub, go.opened, atAdds.open));

    await atAdds.opened;

    const b = await publish(FA, portOf(stub));

    go.open();

    const stored = await a;

    expect([b.version, stored.version, await versions()]).toEqual([1, 2, [1, 2]]);
  });

  function stopsAfterAdditions(file: GrantsFile, live: WorkosPort): Promise<Thrown> {
    let added = false;

    const port: WorkosPort = {
      ...live,
      apply: async function* (step): ReturnType<WorkosPort['apply']> {
        yield* live.apply(step);

        added = true;
      },
      read: () => (added ? stoppedCall() : live.read()),
    };

    const stopped: Db = { ...db, transaction: () => Promise.reject(new Error('The request stopped.')) };

    return failure(publish(file, port, stopped));
  }

  it('path Ghost.3 (rule 5): request A of a canceled job reconciles, request B of the next job adds a permission and stops, then A answers 200', async () => {
    const stub = newStub();

    await publish(FA, portOf(stub));

    await installed();

    const live = portOf(stub);
    const go = gate();
    const atAnswer = gate();
    let reads = 0;

    const held: WorkosPort = {
      ...live,
      read: async function* (): ReturnType<WorkosPort['read']> {
        const read = yield* live.read();

        if (++reads === 2) {
          atAnswer.open();

          await go.opened;
        }

        return read;
      },
    };

    const a = publish(FA, held);

    await atAnswer.opened;

    const b = await stopsAfterAdditions(FB, portOf(stub));

    go.open();

    const answered = await a;

    expect([answered.version, b.status, await versions(), roles(stub)]).toEqual([1, 500, [1], { r1: ['p1', 'p2'] }]);
  });

  it('path Ghost.4 (rule 5, exit 0): the next job exits 0, then request A adds a permission and stops', async () => {
    const stub = newStub();

    await publish(FA, portOf(stub));

    await installed();

    const go = gate();
    const atAdds = gate();
    const a = stopsAfterAdditions(FB, heldPort(stub, go.opened, atAdds.open));

    await atAdds.opened;

    const b = await publish(FA, portOf(stub));

    const afterB = roles(stub);

    go.open();

    await a;

    expect([b.version, afterB, await versions(), roles(stub)]).toEqual([1, { r1: ['p1'] }, [1], { r1: ['p1', 'p2'] }]);
  });
});

describe('the rules of the old model page that a WorkOS failure or a stop breaks (known case 2)', () => {
  it('path JobsEnded (rule 5 as the old page words it): the additions give r1 p2, the request stops, and r1 holds p2 until a rerun', async () => {
    const stub = newStub();

    await publish(FA, portOf(stub));

    let added = false;
    const live = portOf(stub);

    const stopping: WorkosPort = {
      ...live,
      apply: async function* (step): ReturnType<WorkosPort['apply']> {
        yield* live.apply(step);

        added = true;
      },
      read: () => (added ? stoppedCall() : live.read()),
    };

    const stopped: Db = { ...db, transaction: () => Promise.reject(new Error('The request stopped.')) };

    const error = await failure(publish(FB, stopping, stopped));

    expect([error.status, await versions(), roles(stub)]).toEqual([500, [1], { r1: ['p1', 'p2'] }]);

    const rerun = await publish(FB, portOf(stub));

    expect([rerun.version, await versions(), roles(stub)]).toEqual([2, [1, 2], { r1: ['p2'], r2: ['p1'] }]);
  });

  it('path FirstReading (rule 6, first reading): the first publish commits, the WorkOS read of the reconcile fails, and r1 lacks p1 until a rerun', async () => {
    const stub = newStub();

    const failsAfterCommit: Db = {
      ...db,
      transaction: async (run) => {
        const result = await db.transaction(run);

        stub.fail('5xx', { reads: ['permissions', 'roles'] });

        return result;
      },
    };

    const error = await failure(publish(FA, portOf(stub), failsAfterCommit));

    stub.fail(undefined);

    expect([
      error.status,
      error.errorName,
      error.parameters?.['version'],
      error.parameters?.['reconciled'],
      await versions(),
      roles(stub),
    ]).toEqual([503, 'OntologyService:WorkosUnavailable', 1, false, [1], {}]);

    const rerun = await publish(FA, portOf(stub));

    expect([rerun.version, await versions(), roles(stub)]).toEqual([1, [1], { r1: ['p1'] }]);
  });
});

describe('rule 6: a stale reconcile hides a type of the newest version (known case 1)', () => {
  it('path Ghost.8: request A waits for the lock that request B holds, A reconciles from version 1 after B stores version 2, and r1 lacks p2', async () => {
    const stub = newStub();

    await publish(FA, portOf(stub));

    await installOntology(db, {
      rid: `ri.ontology.main.ontology.${crypto.randomUUID()}`,
      product: PRODUCT,
      apiName: 'first',
      displayName: 'first',
      organization: ORGANIZATION,
    });

    const bLocked = gate();
    const bGo = gate();
    const aRead = gate();
    const aGo = gate();

    const holdsLock: Db = {
      ...db,
      transaction: (run) =>
        db.transaction((tx) =>
          run({
            ...tx,
            query: async <Row extends object>(sql: Sql) => {
              const rows = await tx.query<Row>(sql);

              if (sql.text.startsWith(`LOCK TABLE ${VERSIONS}`)) {
                bLocked.open();

                await bGo.opened;
              }

              return rows;
            },
          }),
        ),
    };

    let aReads = 0;
    const live = portOf(stub);

    const aPort: WorkosPort = {
      ...live,
      read: async function* (): ReturnType<WorkosPort['read']> {
        const read = yield* live.read();

        if (++aReads === 2) aRead.open();

        return read;
      },
      setPermissions: async function* (role, permissions): ReturnType<WorkosPort['setPermissions']> {
        await aGo.opened;

        return yield* live.setPermissions(role, permissions);
      },
    };

    const aStarts = gate();

    const aWaits: Db = {
      ...db,
      transaction: async (run) => {
        await aStarts.opened;

        return db.transaction(run);
      },
    };

    const b = publish(FB, portOf(stub), holdsLock);

    await bLocked.opened;

    const a = failure(publish(FA, aPort, aWaits));

    aStarts.open();

    await aRead.opened;

    bGo.open();

    const stored = await b;

    const afterB = roles(stub);

    aGo.open();

    const error = await a;

    expect([stored.version, afterB, error.status, await versions(), roles(stub)]).toEqual([
      2,
      { r1: ['p2'], r2: ['p1'] },
      409,
      [1, 2],
      { r1: ['p1'], r2: ['p1'] },
    ]);
  });
});
