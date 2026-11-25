import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from '../db/index.ts';
import type { Db, SnapshotDb } from '../db/promise.test-utils.ts';
import type { ReportFault } from '../handler/index.ts';
import { sql } from '../publish/publish.test-utils.ts';
import { routeSpans } from '../routeHarness.test-utils.ts';
import { asSnapshot } from '../service.test-utils.ts';
import {
  errorAnswer,
  NS,
  rowsOf,
  seedClient,
  startActions,
  type ActionsService,
} from '../actions/actions.test-utils.ts';
import { actionOf, withFunctions, type TestFunction } from './functions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const accountId = { name: 'accountId', type: 'string' as const };
const edits = [ACCOUNT];

const FUNCTIONS: TestFunction[] = [
  { apiName: 'readName', inputs: [accountId], edits },
  { apiName: 'readObjectInput', inputs: [{ name: 'account', type: 'object', objectType: ACCOUNT }], edits },
  { apiName: 'readTwice', inputs: [accountId], edits },
  { apiName: 'readOwnEdit', inputs: [accountId], edits },
  { apiName: 'applyFromClient', inputs: [accountId], edits },
  { apiName: 'readAndIgnoreFailure', inputs: [accountId], edits },
  { apiName: 'readObjectList', inputs: [{ name: 'accounts', type: 'objectList', objectType: ACCOUNT }], edits },
];

const SOURCE = `
import { createClient as osdkCreateClient } from '@osdk/client';
import { createEditBatch } from '@osdk/functions';

export const createClient = (...args) => {
  const client = osdkCreateClient(...args);
  globalThis.clients = (globalThis.clients ?? 0) + 1;
  return client;
};

const Account = { type: 'object', apiName: '${ACCOUNT}' };
const CreateAccount = { type: 'action', apiName: '${NS}create-account' };

function report(client, fact, batch = createEditBatch(client)) {
  batch.create(Account, { accountId: 'report', name: JSON.stringify(fact) });
  return batch.getEdits();
}

export const functions = {
  readName: async (client, accountId) => {
    const account = await client(Account).fetchOne(accountId);
    return report(client, { name: account.name, apiName: account.$apiName, primaryKey: account.$primaryKey, fromBundle: globalThis.clients > 0 });
  },
  readObjectInput: async (client, account) =>
    report(client, { name: account.name, phase: account.phase, apiName: account.$apiName, primaryKey: account.$primaryKey }),
  readTwice: async (client, accountId) => {
    const first = await client(Account).fetchOne(accountId);
    // The test commits a change after the first read, and then posts on the channel.
    const channel = new BroadcastChannel('reads.sql.test.ts readTwice');
    await new Promise((resolve) => {
      channel.onmessage = resolve;
      channel.postMessage('read');
    });
    channel.close();
    const second = await client(Account).fetchOne(accountId);
    return report(client, { first: first.phase, second: second.phase });
  },
  readOwnEdit: async (client, accountId) => {
    const batch = createEditBatch(client);
    batch.update({ $apiName: '${ACCOUNT}', $primaryKey: accountId }, { phase: 'edited' });
    const account = await client(Account).fetchOne(accountId);
    return report(client, { phase: account.phase }, batch);
  },
  applyFromClient: async (client, accountId) => {
    try {
      await client(CreateAccount).applyAction({ accountId: 'from-function', name: 'From a Function' });
      return report(client, { applied: true });
    } catch (error) {
      // The Action client of @osdk/client 2.92.0 wraps the OSDK API error of the answer as the cause of its error.
      const answer = error.cause ?? error;
      return report(client, { statusCode: answer.statusCode, errorName: answer.errorName });
    }
  },
  readObjectList: async (client, accounts) => report(client, { names: accounts.map((account) => account.name), primaryKeys: accounts.map((account) => account.$primaryKey) }),
  readAndIgnoreFailure: async (client, accountId) => {
    try {
      await client(Account).fetchOne(accountId);
    } catch {
      // The Function goes on as if the read gave nothing.
    }
    return report(client, { read: 'failed' });
  },
};
`;

let service: ActionsService;

beforeAll(async () => {
  const { ir, functions } = await withFunctions(FUNCTIONS, SOURCE);

  service = await startActions(ir, functions);
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  await seedClient(service.db);
});

const EXECUTE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' };

function apply(apiName: string, parameters: Record<string, unknown>, db?: Db, reportFault?: ReportFault) {
  return service.apply(
    actionOf(apiName),
    { parameters, options: EXECUTE },
    { ...(db ? { db } : {}), ...(reportFault ? { reportFault } : {}) },
  );
}

async function reported(): Promise<unknown> {
  const rows = (await service.db.query<{ name: string }>(
    sql("SELECT name FROM ontology_1_objects.account WHERE account_id = 'report'"),
  )) as { name: string }[];

  return rows[0] ? (JSON.parse(rows[0].name) as unknown) : undefined;
}

function watchedDb(onRead: (snapshot: SnapshotDb, sql: Sql) => Promise<void>): Db {
  const { db } = service;

  const watch = (snapshot: SnapshotDb): SnapshotDb => {
    const reads = (sql: Sql) => sql.text.includes('FROM "ontology_1_objects"."account"');

    return asSnapshot({
      query: async <Row extends object>(sql: Sql) => {
        if (reads(sql)) await onRead(snapshot, sql);

        return snapshot.query<Row>(sql);
      },
      stream: <Row extends object>(sql: Sql) => {
        if (!reads(sql)) return snapshot.stream<Row>(sql);

        return (async function* () {
          await onRead(snapshot, sql);

          yield* snapshot.stream<Row>(sql);
        })();
      },
      snapshot: (run) => snapshot.snapshot(run),
      transaction: (run) => snapshot.transaction(run),
    });
  };

  return {
    ...db,
    query: (q) => db.query(q),
    stream: (q) => db.stream(q),
    transaction: (run) => db.transaction(run),
    snapshot: (run) => db.snapshot((s) => run(watch(s))),
  };
}

function watchedStreamDb(): Db {
  const { db } = service;

  const watch = (snapshot: SnapshotDb): SnapshotDb =>
    asSnapshot({
      query: <Row extends object>(sql: Sql) => snapshot.query<Row>(sql),
      stream: <Row extends object>(sql: Sql) => {
        if (!sql.text.includes('FROM "ontology_1_objects"."account"')) return snapshot.stream<Row>(sql);

        return (async function* () {
          for await (const row of snapshot.stream<Row>(sql)) {
            yield row;

            throw new Error('The test fails the stream after its first row.');
          }
        })();
      },
      snapshot: (run) => snapshot.snapshot(run),
      transaction: (run) => snapshot.transaction(run),
    });

  return {
    ...db,
    query: (q) => db.query(q),
    stream: (q) => db.stream(q),
    transaction: (run) => db.transaction(run),
    snapshot: (run) => db.snapshot((s) => run(watch(s))),
  };
}

describe("the Function's client", () => {
  it(
    'ontology/functions/functions#code, ontology/functions/functions#reads, service/code-layout#seams: ' +
      'the first parameter is a stock @osdk/client that the createClient of the bundle makes, and it reads an Object',
    async () => {
      expect((await apply('readName', { accountId: 'acc-1' })).status).toBe(200);

      expect(await reported()).toEqual({ name: 'Acme', apiName: ACCOUNT, primaryKey: 'acc-1', fromBundle: true });
    },
  );

  it('an Object input reaches the Function as an Object that the client loaded, with its Property values', async () => {
    expect((await apply('readObjectInput', { account: 'acc-2' })).status).toBe(200);

    expect(await reported()).toEqual({ name: 'Globex', phase: 'prospect', apiName: ACCOUNT, primaryKey: 'acc-2' });
  });

  it('an Object list input reaches the Function as the Objects that the client loaded', async () => {
    expect((await apply('readObjectList', { accounts: ['acc-3', 'acc-1'] })).status).toBe(200);

    expect(await reported()).toEqual({ names: ['Initech', 'Acme'], primaryKeys: ['acc-3', 'acc-1'] });
  });

  it('the worker loads an Object list input with 1 read of its primary keys, with no repeated key, and keeps the order of the list', async () => {
    const reads: unknown[] = [];

    const db = watchedDb((_, read) => {
      reads.push(read.values[0]);

      return Promise.resolve();
    });

    expect((await apply('readObjectList', { accounts: ['acc-3', 'acc-1', 'acc-3'] }, db)).status).toBe(200);

    expect(await reported()).toEqual({
      names: ['Initech', 'Acme', 'Initech'],
      primaryKeys: ['acc-3', 'acc-1', 'acc-3'],
    });

    expect(reads).toEqual([['acc-3', 'acc-1']]);
  });

  it('an Object list input with an Object that does not exist gets 400 FunctionExecutionFailed, and the Function does not run', async () => {
    const answer = errorAnswer(await apply('readObjectList', { accounts: ['acc-1', 'p-missing'] }));

    expect(answer).toMatchObject({
      status: 400,
      body: { errorName: 'FunctionExecutionFailed', parameters: { message: 'Object not found' } },
    });

    expect(await reported()).toBeUndefined();
  });

  it('an Object input that does not exist gets 400 FunctionExecutionFailed, and the Function does not run', async () => {
    const answer = errorAnswer(await apply('readObjectInput', { account: 'p-missing' }));

    expect(answer).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'FunctionExecutionFailed',
        parameters: {
          functionRid: expect.stringMatching(/^ri\.function-registry\.main\.function\./),
          functionVersion: '1.0.0',
          message: 'Object not found',
        },
      },
    });

    expect(await reported()).toBeUndefined();
  });

  it('ontology/functions/functions#reads: an apply from the client gets 403 Default:PermissionDenied', async () => {
    expect((await apply('applyFromClient', { accountId: 'acc-1' })).status).toBe(200);

    expect(await reported()).toEqual({ statusCode: 403, errorName: 'Default:PermissionDenied' });

    expect((await rowsOf(service.db, ACCOUNT, 'account_id')).map((row) => row['account_id'])).not.toContain(
      'from-function',
    );
  });
});

describe('the snapshot of a run', () => {
  it(
    'ontology/functions/functions#reads: ' +
      'all reads of 1 run see 1 snapshot, so a change that commits during the run is not in the second read',
    async () => {
      const channel = new BroadcastChannel('reads.sql.test.ts readTwice');
      const firstRead = new Promise((resolve) => (channel.onmessage = resolve));

      try {
        const run = apply('readTwice', { accountId: 'acc-1' });

        await firstRead;

        const change = await service.apply(`${NS}set-account-phase`, {
          parameters: { objectToModifyParameter: 'acc-1', phase: 'churned' },
          options: EXECUTE,
        });

        expect(change.status).toBe(200);

        channel.postMessage('changed');

        expect((await run).status).toBe(200);
      } finally {
        channel.close();
      }

      expect(await reported()).toEqual({ first: 'customer', second: 'customer' });
    },
  );

  it('ontology/functions/functions#reads: a read does not see an edit of the same run', async () => {
    expect((await apply('readOwnEdit', { accountId: 'acc-1' })).status).toBe(200);

    expect(await reported()).toEqual({ phase: 'customer' });

    const rows = (await rowsOf(service.db, ACCOUNT, 'account_id')) as { account_id: string; phase: string }[];

    expect(rows.find((row) => row.account_id === 'acc-1')?.phase).toBe('edited');
  });

  it('service/storage#writes: the client reads in a read-only REPEATABLE READ transaction', async () => {
    const settings: unknown[] = [];

    const db = watchedDb(async (snapshot) => {
      const [row] = await snapshot.query<{ isolation: string; readOnly: string }>(
        sql(
          "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS \"readOnly\"",
        ),
      );

      settings.push(row);
    });

    expect((await apply('readName', { accountId: 'acc-1' }, db)).status).toBe(200);

    expect(settings.length).toBeGreaterThan(0);

    expect(new Set(settings.map((s) => JSON.stringify(s)))).toEqual(
      new Set([JSON.stringify({ isolation: 'repeatable read', readOnly: 'on' })]),
    );
  });

  it('skips SELECT count(*) for internal loadInputs while keeping exact totalCount on external loadObjects and Function reads', async () => {
    const inputQueries: string[] = [];

    const inputDb = watchedDb(async (_snapshot, statement) => {
      inputQueries.push(statement.text);
    });

    expect((await apply('readObjectInput', { account: 'acc-1' }, inputDb)).status).toBe(200);

    expect(inputQueries.length).toBeGreaterThan(0);
    expect(inputQueries.some((text) => text.includes('count(*)'))).toBe(false);

    expect(await reported()).toEqual({ apiName: ACCOUNT, primaryKey: 'acc-1', name: 'Acme', phase: 'customer' });

    await service.db.query(sql("DELETE FROM ontology_1_objects.account WHERE account_id = 'report'"));

    const bodyQueries: string[] = [];

    const bodyDb = watchedDb(async (_snapshot, statement) => {
      bodyQueries.push(statement.text);
    });

    expect((await apply('readName', { accountId: 'acc-1' }, bodyDb)).status).toBe(200);

    expect(bodyQueries.some((text) => text.includes('count(*)'))).toBe(true);

    const external = await service.loadObjects({
      objectSet: { type: 'base', objectType: ACCOUNT },
      pageSize: 1,
    });

    expect(external.status).toBe(200);
    expect((external.body as { totalCount: string; data: unknown[] }).totalCount).toBe('4');
    expect((external.body as { totalCount: string; data: unknown[] }).data).toHaveLength(1);
  });
});

describe('a 5xx of a request of the client', () => {
  const failingDb = () =>
    watchedDb(() => Promise.reject(new Error('The test fails each read of the Account table in the snapshot.')));

  it('ontology/functions/functions#errors: the app gets 500 Default:Internal when the Function rethrows', async () => {
    expect(errorAnswer(await apply('readName', { accountId: 'acc-1' }, failingDb()))).toEqual({
      status: 500,
      body: { errorCode: 'INTERNAL', errorName: 'Default:Internal', parameters: {} },
    });

    expect(await reported()).toBeUndefined();
  });

  it('ontology/functions/functions#errors: the app gets 500 Default:Internal when a read fails after its first row', async () => {
    const db = watchedStreamDb();

    expect(errorAnswer(await apply('readAndIgnoreFailure', { accountId: 'acc-1' }, db))).toEqual({
      status: 500,
      body: { errorCode: 'INTERNAL', errorName: 'Default:Internal', parameters: {} },
    });

    expect(await reported()).toBeUndefined();
  });

  it('service/observability#error-reports: the fault gets 1 report, with the errorInstanceId of the answer of the app', async () => {
    const reportFault = vi.fn<ReportFault>();

    const answer = await apply('readName', { accountId: 'acc-1' }, failingDb(), reportFault);

    expect(answer.status).toBe(500);

    const { errorInstanceId } = answer.body as { errorInstanceId: string };
    const route = 'POST /api/v2/ontologies/{ontology}/actions/{action}/apply';

    const root = (await routeSpans()).find((span) => span.name === route);

    expect(root?.traceId).toMatch(/^[0-9a-f]{32}$/);

    expect(reportFault.mock.calls).toEqual([
      [
        expect.any(Error),
        {
          errorInstanceId,
          errorName: 'Default:Internal',
          route,
          ontologyVersion: expect.any(Number),
          userId: expect.any(String),
          callerKind: 'person',
          traceId: root?.traceId,
          rootSpanId: root?.spanId,
        },
      ],
    ]);
  });

  it('ontology/functions/functions#runtime: a dropped connection during a read of the client gives 500 Default:Internal, and the Action writes nothing', async () => {
    let dropped = false;

    const db = watchedDb(async (snapshot) => {
      if (dropped) return;

      dropped = true;

      const [row] = await snapshot.query<{ pid: number }>(sql('SELECT pg_backend_pid() AS pid'));

      await service.db.query(sql(`SELECT pg_terminate_backend(${row?.pid})`));
    });

    expect(errorAnswer(await apply('readName', { accountId: 'acc-1' }, db))).toEqual({
      status: 500,
      body: { errorCode: 'INTERNAL', errorName: 'Default:Internal', parameters: {} },
    });

    expect(dropped).toBe(true);

    expect(await reported()).toBeUndefined();
  });

  it('ontology/functions/functions#errors: the app gets 500 Default:Internal also when the Function goes on and returns edits', async () => {
    expect(errorAnswer(await apply('readAndIgnoreFailure', { accountId: 'acc-1' }, failingDb()))).toEqual({
      status: 500,
      body: { errorCode: 'INTERNAL', errorName: 'Default:Internal', parameters: {} },
    });

    expect(await reported()).toBeUndefined();
  });
});
