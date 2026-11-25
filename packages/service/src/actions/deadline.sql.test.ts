import pg from 'pg';
import { SpanStatusCode } from '@opentelemetry/api';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Sql } from '../db/index.ts';
import { createDb, createPool, type Db } from '../db/promise.test-utils.ts';
import { unchecked } from '../ontology/stored.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import { routeSpans } from '../routeHarness.test-utils.ts';
import {
  errorAnswer,
  NS,
  racingDb,
  rowsOf,
  seedClient,
  startActions,
  twinFunctions,
  twinIr,
  type ActionsService,
  type Answer,
} from './actions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const SET_ENGAGEMENT_STATUS = `${NS}set-engagement-status`;
const CREATE_ENGAGEMENT = `${NS}create-engagement`;
const PROBE_VERSION_CHECK = `${NS}probe-version-check-action`;

const EXECUTE_NONE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };
const ACTION_RID = /^ri\.actions\.main\.action\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const APPLIED = {
  status: 200,
  body: {
    operationId: expect.stringMatching(ACTION_RID),
    validation: { result: 'VALID', submissionCriteria: [], parameters: {} },
  },
};

const PAST_DEADLINE = {
  status: 400,
  body: { errorCode: 'INVALID_ARGUMENT', errorName: 'ActionDeadlineExceeded', parameters: {} },
};

const ABORTED = {
  status: 400,
  body: { errorCode: 'INVALID_ARGUMENT', errorName: 'ActionRequestAborted', parameters: {} },
};

const INTERNAL = { status: 500, body: { errorCode: 'INTERNAL', errorName: 'Default:Internal', parameters: {} } };
const LIMIT = "SELECT set_config('transaction_timeout', $1, true), set_config('statement_timeout', '0', true)";

function historyIr() {
  const ir = twinIr('0.6.3');

  for (const apiName of [ENGAGEMENT, ACCOUNT]) {
    const block = ir.ontology.objectTypes[apiName];

    if (!block) throw new Error(`The twin 0.6.3 IR has no ${apiName}.`);

    block.entityMetadata = unchecked({
      ...block.entityMetadata,
      editsHistory: { type: 'config', config: { store: apiName, storeAllPreviousProperties: false } },
    });
  }

  return ir;
}

let service: ActionsService;
let uncaught: unknown[];
const onUncaught = (error: unknown) => void uncaught.push(error);

beforeAll(async () => {
  service = await startActions(historyIr(), twinFunctions('0.6.3'));
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  await seedClient(service.db);

  uncaught = [];

  process.on('uncaughtException', onUncaught);
});

afterEach(() => {
  process.off('uncaughtException', onUncaught);

  vi.useRealTimers();
});

let arrived: number;

function arrive(): void {
  vi.useFakeTimers({ toFake: ['Date'] });

  vi.setSystemTime(Date.now());

  arrived = Date.now();
}

const at = (ms: number) => vi.setSystemTime(arrived + ms);

interface Watch {
  readonly read?: () => void;
  readonly ran?: () => void;
  readonly open?: () => void;
  readonly statement?: (statement: Sql, index: number, tx: Db) => Promise<void> | void;
  readonly failed?: () => Promise<void> | void;
  readonly committed?: () => void;
}

function watchedDb(
  base: Db,
  watch: Watch,
): { readonly db: Db; readonly statements: Sql[]; readonly transactions: () => number } {
  const statements: Sql[] = [];
  let transactions = 0;
  let read = watch.read;

  const db: Db = {
    query: async <Row extends object>(statement: Sql) => {
      read?.();

      read = undefined;

      return base.query<Row>(statement);
    },
    stream: (statement) => base.stream(statement),
    snapshot: async (run) => {
      const result = await base.snapshot(run);

      watch.ran?.();

      return result;
    },
    transaction: async (run) => {
      transactions += 1;

      const result = await base
        .transaction(async (tx) => {
          watch.open?.();

          const watched: Db = {
            ...tx,
            query: async <Row extends object>(statement: Sql) => {
              const index = statements.push(statement) - 1;

              await watch.statement?.(statement, index, tx);

              return tx.query<Row>(statement);
            },
          };

          return run(watched);
        })
        .catch(async (error: unknown) => {
          await watch.failed?.();

          throw error;
        });

      watch.committed?.();

      return result;
    },
  };

  return { db, statements, transactions: () => transactions };
}

const isEditStatement = (statement: Sql) =>
  statement.text.startsWith('UPDATE ') || statement.text.startsWith('INSERT INTO "ontology_1_objects"');

const setStatus = (engagementId: string, status: string, db?: Db, signal?: AbortSignal) =>
  service.apply(
    SET_ENGAGEMENT_STATUS,
    { parameters: { objectToModifyParameter: engagementId, status }, options: EXECUTE_NONE },
    { ...(db ? { db } : {}), ...(signal ? { signal } : {}) },
  );

const answerOf = (answer: Answer) => (answer.status === 200 ? answer : errorAnswer(answer));

const statusOf = async (engagementId: string) =>
  (await rowsOf(service.db, ENGAGEMENT, 'engagement_id')).find((row) => row['engagement_id'] === engagementId)?.[
    'status'
  ];

const entries = async () =>
  (
    await service.db.query<{ count: number }>(sql('SELECT count(*)::int AS count FROM ontology_1_engine.edit_history'))
  )[0]?.count;

function lineOf(log: MockInstance<typeof console.log>, answer: Answer): Record<string, unknown> | undefined {
  const errorInstanceId = (answer.body as { errorInstanceId?: string }).errorInstanceId;

  return log.mock.calls
    .map(([text]) => JSON.parse(String(text)) as Record<string, unknown>)
    .find((logged) => logged['errorInstanceId'] === errorInstanceId);
}

async function holder(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: service.url });

  await client.connect();

  await client.query('BEGIN');

  return client;
}

function onePool(): { readonly db: Db; readonly pool: pg.Pool } {
  const pool = createPool(service.url, { max: 1 });

  return { db: createDb(pool), pool };
}

async function withRoleSetting<T>(name: string, value: string, run: () => Promise<T>): Promise<T> {
  await service.db.query(sql(`ALTER ROLE CURRENT_USER SET ${name} = '${value}'`));

  try {
    return await run();
  } finally {
    await service.db.query(sql(`ALTER ROLE CURRENT_USER RESET ${name}`));
  }
}

const backendPid = async (db: Db) => (await db.query<{ pid: number }>(sql('SELECT pg_backend_pid() AS pid')))[0]?.pid;

async function lockedApply(
  db: Db,
): Promise<{ readonly answer: Answer; readonly elapsed: number; readonly line: Record<string, unknown> | undefined }> {
  const held = await holder();

  const log: MockInstance<typeof console.log> = vi.spyOn(console, 'log');

  try {
    await held.query("SELECT 1 FROM ontology_1_objects.engagement WHERE engagement_id = 'eng-2' FOR UPDATE");

    arrive();

    const watched = watchedDb(db, { read: () => at(119_500) });
    const started = performance.now();

    const answer = await setStatus('eng-2', 'won', watched.db);

    const elapsed = performance.now() - started;
    const line = lineOf(log, answer);

    return { answer, elapsed, line };
  } finally {
    log.mockRestore();

    await held.query('COMMIT');

    await held.end();
  }
}

describe('the time that remains', () => {
  it('service/storage#writes: with the clock at 115,000 ms at the check, the apply writes, and the first statement of its transaction sets the limit 5000ms, which ends with the transaction', async () => {
    const { db, pool } = onePool();

    try {
      const inside: unknown[] = [];

      arrive();

      const watched = watchedDb(db, {
        read: () => at(115_000),
        statement: async (_statement, index, tx) => {
          if (index !== 1) return;

          const [row] = await tx.query<{ transaction: string; statement: string; pid: number }>(
            sql(
              "SELECT current_setting('transaction_timeout') AS transaction, current_setting('statement_timeout') AS statement, pg_backend_pid() AS pid",
            ),
          );

          inside.push(row);
        },
      });

      expect(answerOf(await setStatus('eng-2', 'won', watched.db))).toEqual(APPLIED);

      expect(watched.statements[0]).toEqual({ text: LIMIT, values: ['5000ms'] });
      expect(inside).toEqual([{ transaction: '5s', statement: '0', pid: expect.any(Number) }]);

      const [after] = await db.query<{ transaction: string; pid: number }>(
        sql("SELECT current_setting('transaction_timeout') AS transaction, pg_backend_pid() AS pid"),
      );

      expect(after).toEqual({ transaction: '0', pid: (inside[0] as { pid: number }).pid });

      expect(await statusOf('eng-2')).toBe('won');

      expect(await entries()).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it('service/storage#writes: a VALIDATE_ONLY apply with the clock at 200,000 ms gets 200 with the result VALID, because it has no deadline', async () => {
    arrive();

    const watched = watchedDb(service.db, { read: () => at(200_000) });

    const answer = await service.apply(
      SET_ENGAGEMENT_STATUS,
      {
        parameters: { objectToModifyParameter: 'eng-2', status: 'won' },
        options: { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' },
      },
      { db: watched.db },
    );

    expect(answer.status).toBe(200);
    expect((answer.body as { validation: { result: string } }).validation.result).toBe('VALID');
    expect(watched.transactions()).toBe(0);
  });

  it('service/storage#writes: with a role statement_timeout of 200ms, a row lock wait of 800 ms does not end the apply at 118,000 ms', async () => {
    await withRoleSetting('statement_timeout', '200ms', async () => {
      const pool = createPool(service.url);

      const held = await holder();

      try {
        await held.query("SELECT 1 FROM ontology_1_objects.engagement WHERE engagement_id = 'eng-2' FOR UPDATE");

        arrive();

        const locking = Promise.withResolvers<undefined>();

        const watched = watchedDb(createDb(pool), {
          read: () => at(118_000),
          statement: (_statement, index) => {
            if (index === 1) locking.resolve(undefined);
          },
        });

        const applied = setStatus('eng-2', 'won', watched.db);

        await locking.promise;

        await new Promise((resolve) => setTimeout(resolve, 800));

        await held.query('COMMIT');

        expect(answerOf(await applied)).toEqual(APPLIED);

        expect(await statusOf('eng-2')).toBe('won');
      } finally {
        await held.end();

        await pool.end();
      }
    });
  });
});

describe('no time left at a check', () => {
  it('service/storage#writes: with the clock at 119,999 ms, the limit statement has the value 1ms', async () => {
    arrive();

    const statements: Sql[] = [];

    const stub: Db = {
      ...service.db,
      query: <Row extends object>(statement: Sql) => {
        at(119_999);

        return service.db.query<Row>(statement);
      },
      transaction: (run) =>
        run({
          ...service.db,
          query: (statement: Sql) => {
            statements.push(statement);

            return Promise.reject(new Error('The stub transaction writes nothing.'));
          },
        }),
    };

    expect(answerOf(await setStatus('eng-2', 'won', stub))).toEqual(INTERNAL);

    expect(statements).toEqual([{ text: LIMIT, values: ['1ms'] }]);

    expect(await statusOf('eng-2')).toBe('open');
  });

  it('service/storage#writes service/http-api#errors: with the clock at 120,000 ms at the first check, the apply gets 400 ActionDeadlineExceeded with parameters {}, opens no transaction, and writes no edit and no entry', async () => {
    arrive();

    const watched = watchedDb(service.db, { read: () => at(120_000) });

    expect(answerOf(await setStatus('eng-2', 'won', watched.db))).toEqual(PAST_DEADLINE);

    expect(watched.transactions()).toBe(0);

    expect(await statusOf('eng-2')).toBe('open');

    expect(await entries()).toBe(0);
  });

  it('service/storage#writes: when the clock moves to 120,000 ms as the transaction gets its connection, the apply gets the deadline answer, runs no statement in the transaction, and writes no edit and no entry', async () => {
    arrive();

    const watched = watchedDb(service.db, { open: () => at(120_000) });

    expect(answerOf(await setStatus('eng-2', 'won', watched.db))).toEqual(PAST_DEADLINE);

    expect(watched.transactions()).toBe(1);
    expect(watched.statements).toEqual([]);

    expect(await statusOf('eng-2')).toBe('open');

    expect(await entries()).toBe(0);
  });
});

describe('the limit ends the write', () => {
  it('service/storage#writes: a row lock wait ends at the deadline with the deadline answer, writes nothing, and the next apply runs on a new backend pid', async () => {
    const { db, pool } = onePool();

    try {
      const before = await backendPid(db);

      const { answer, elapsed } = await lockedApply(db);

      expect(answerOf(answer)).toEqual(PAST_DEADLINE);
      expect(elapsed).toBeGreaterThanOrEqual(400);
      expect(elapsed).toBeLessThan(5_000);

      expect(await statusOf('eng-2')).toBe('open');

      expect(await entries()).toBe(0);

      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(uncaught).toEqual([]);

      vi.useRealTimers();

      const pids: number[] = [];

      arrive();

      const next = watchedDb(db, {
        statement: async (_statement, index, tx) => {
          if (index === 0) pids.push((await backendPid(tx)) ?? 0);
        },
      });

      expect(answerOf(await setStatus('eng-2', 'won', next.db))).toEqual(APPLIED);

      expect(pids).toHaveLength(1);
      expect(pids[0]).not.toBe(before);
    } finally {
      await pool.end();
    }
  });

  it('service/observability#logs: the request log of a row lock wait that the deadline ends has status 400, the errorName ActionDeadlineExceeded, parameters {}, a stack that holds transaction timeout, the same keys as an aborted apply, and no new span kind', async () => {
    const aborted = new AbortController();
    const log = vi.spyOn(console, 'log');
    let abortedLine: Record<string, unknown> | undefined;

    try {
      const abortedAnswer = await setStatus(
        'eng-2',
        'won',
        watchedDb(service.db, { read: () => aborted.abort() }).db,
        aborted.signal,
      );

      expect(answerOf(abortedAnswer)).toEqual(ABORTED);

      abortedLine = lineOf(log, abortedAnswer);
    } finally {
      log.mockRestore();
    }

    arrive();

    expect(answerOf(await setStatus('eng-3', 'won'))).toEqual(APPLIED);

    const applied = await routeSpans();

    vi.useRealTimers();

    const { db, pool } = onePool();

    try {
      const { answer, line } = await lockedApply(db);

      const stopped = (await routeSpans()).slice(applied.length);

      expect(answer.status).toBe(400);
      expect(line).toMatchObject({ errorName: 'ActionDeadlineExceeded', parameters: {} });
      expect(String(line?.['stack'])).toContain('transaction timeout');
      expect(Object.keys(line ?? {}).sort()).toEqual(Object.keys(abortedLine ?? {}).sort());

      const kinds = (spans: typeof applied) => [...new Set(spans.map((span) => span.name))].sort();

      expect(kinds(stopped).filter((kind) => !kinds(applied).includes(kind))).toEqual([]);

      const limitSpans = (spans: typeof applied) =>
        spans.filter(
          (span) => span.name === 'sql' && String(span.attributes['sql.template']).startsWith('SELECT set_config('),
        );

      expect(limitSpans(applied).map((span) => span.attributes['sql.held'])).toEqual([true]);
      expect(limitSpans(stopped).map((span) => span.attributes['sql.held'])).toEqual([true]);
    } finally {
      await pool.end();
    }
  });

  it('service/storage#writes: an edit statement that waits on an uncommitted create of the same key ends at the deadline, and no such Object exists after', async () => {
    const held = await holder();

    try {
      await held.query(
        "INSERT INTO ontology_1_objects.engagement (engagement_id, account_id, title, amount, status) VALUES ('eng-held', 'acc-1', 'Held', 1, 'open')",
      );

      arrive();

      const watched = watchedDb(service.db, { read: () => at(119_500) });

      const answer = await service.apply(
        CREATE_ENGAGEMENT,
        { parameters: { engagementId: 'eng-held', title: 'Late' }, options: EXECUTE_NONE },
        { db: watched.db },
      );

      expect(answerOf(answer)).toEqual(PAST_DEADLINE);
    } finally {
      await held.query('ROLLBACK');

      await held.end();
    }

    expect(await statusOf('eng-held')).toBeUndefined();

    expect(await entries()).toBe(0);
  });

  it('service/storage#writes: the insert of the Object Edit History entries ends at the deadline, and the modify writes nothing', async () => {
    const held = await holder();

    try {
      await held.query('LOCK TABLE ontology_1_engine.edit_history IN EXCLUSIVE MODE');

      arrive();

      const watched = watchedDb(service.db, { read: () => at(119_500) });

      expect(answerOf(await setStatus('eng-2', 'won', watched.db))).toEqual(PAST_DEADLINE);
    } finally {
      await held.query('COMMIT');

      await held.end();
    }

    expect(await statusOf('eng-2')).toBe('open');

    expect(await entries()).toBe(0);
  });

  it('service/storage#writes: a deferred trigger that passes the limit at COMMIT gets the deadline answer, and the modify writes nothing', async () => {
    await service.db.query(
      sql(
        'CREATE FUNCTION public.deadline_sleep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2); RETURN NULL; END $$',
      ),
    );

    await service.db.query(
      sql(
        'CREATE CONSTRAINT TRIGGER deadline_sleep AFTER UPDATE ON ontology_1_objects.engagement DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.deadline_sleep()',
      ),
    );

    try {
      arrive();

      const watched = watchedDb(service.db, { read: () => at(119_500) });

      expect(answerOf(await setStatus('eng-2', 'won', watched.db))).toEqual(PAST_DEADLINE);

      expect(await statusOf('eng-2')).toBe('open');

      expect(await entries()).toBe(0);
    } finally {
      await service.db.query(sql('DROP TRIGGER deadline_sleep ON ontology_1_objects.engagement'));

      await service.db.query(sql('DROP FUNCTION public.deadline_sleep()'));
    }
  });
});

describe('a failure with no Postgres code', () => {
  const failingEdit = (ms: number) =>
    watchedDb(service.db, {
      statement: (statement) => {
        if (!isEditStatement(statement)) return;

        at(ms);

        throw new Error('The test ends the write before its first edit statement.');
      },
    });

  it('service/storage#writes: before COMMIT, past the deadline, it gets the deadline answer, and its request log keeps the stack of the failure; at 100,000 ms it gets 500; each writes nothing', async () => {
    arrive();

    const log = vi.spyOn(console, 'log');
    let past: Answer;
    let line: Record<string, unknown> | undefined;

    try {
      past = await setStatus('eng-2', 'won', failingEdit(120_001).db);

      line = lineOf(log, past);
    } finally {
      log.mockRestore();
    }

    expect(answerOf(past)).toEqual(PAST_DEADLINE);
    expect(line).toMatchObject({ errorName: 'ActionDeadlineExceeded', parameters: {} });
    expect(String(line?.['stack'])).toContain('The test ends the write before its first edit statement.');

    vi.useRealTimers();

    arrive();

    expect(answerOf(await setStatus('eng-2', 'won', failingEdit(100_000).db))).toEqual(INTERNAL);

    expect(await statusOf('eng-2')).toBe('open');

    expect(await entries()).toBe(0);
  });

  it('service/storage#writes: after the commit, past the deadline, it gets 500 and never 400, and the edit exists', async () => {
    arrive();

    const watched = watchedDb(service.db, {
      committed: () => {
        at(120_001);

        throw new Error('The test fails the apply after its commit.');
      },
    });

    expect(answerOf(await setStatus('eng-2', 'won', watched.db))).toEqual(INTERNAL);

    expect(await statusOf('eng-2')).toBe('won');

    expect(await entries()).toBe(1);
  });

  it('a failure with no code before COMMIT of a request that the client aborted during the write gets 400 ActionRequestAborted, and writes nothing', async () => {
    const aborted = new AbortController();

    const watched = watchedDb(service.db, {
      statement: (statement) => {
        if (!isEditStatement(statement)) return;

        aborted.abort();

        throw new Error('The test ends the write before its first edit statement.');
      },
    });

    expect(answerOf(await setStatus('eng-2', 'won', watched.db, aborted.signal))).toEqual(ABORTED);

    expect(await statusOf('eng-2')).toBe('open');

    expect(await entries()).toBe(0);
  });

  it('service/storage#writes: the idle limit of the role ends the session during a wait before the first edit statement; at 100,000 ms the apply gets 500, and past the deadline the deadline answer; each writes nothing', async () => {
    await withRoleSetting('idle_in_transaction_session_timeout', '200ms', async () => {
      for (const [ms, expected] of [
        [100_000, INTERNAL],
        [120_001, PAST_DEADLINE],
      ] as const) {
        const pool = createPool(service.url);

        try {
          vi.useRealTimers();

          arrive();

          const watched = watchedDb(createDb(pool), {
            statement: async (statement) => {
              if (!isEditStatement(statement)) return;

              await new Promise((resolve) => setTimeout(resolve, 600));

              at(ms);
            },
          });

          expect(answerOf(await setStatus('eng-2', 'won', watched.db))).toEqual(expected);

          expect(await statusOf('eng-2')).toBe('open');

          expect(await entries()).toBe(0);
        } finally {
          await pool.end();
        }
      }
    });
  });
});

describe('the attempts of a rule-backed Action', () => {
  it('service/storage#writes: each attempt gets the time that remains at its own check: attempt 1 at 110,000 ms gets 10000ms and fails its version check, and attempt 2 at 119,500 ms gets 500ms and ends at the deadline on a held row', async () => {
    const held = await holder();

    try {
      arrive();

      const raced = racingDb(
        service.db,
        sql(
          "UPDATE ontology_1_objects.engagement SET title = 'Renamed', __version = __version + 1 WHERE engagement_id = 'eng-2'",
        ),
        1,
      );

      const watched = watchedDb(raced.db, {
        read: () => at(110_000),
        failed: async () => {
          at(119_500);

          await held.query("SELECT 1 FROM ontology_1_objects.engagement WHERE engagement_id = 'eng-2' FOR UPDATE");
        },
      });

      expect(answerOf(await setStatus('eng-2', 'won', watched.db))).toEqual(PAST_DEADLINE);

      expect(
        watched.statements.filter((statement) => statement.text === LIMIT).map((statement) => statement.values[0]),
      ).toEqual(['10000ms', '500ms']);

      expect(watched.transactions()).toBe(2);
    } finally {
      await held.query('COMMIT');

      await held.end();
    }

    expect(
      await rowsOf(service.db, ENGAGEMENT, 'engagement_id').then((rows) =>
        rows.find((row) => row['engagement_id'] === 'eng-2'),
      ),
    ).toMatchObject({ title: 'Renamed', status: 'open' });

    expect(await entries()).toBe(0);
  });

  it('service/storage#writes: when attempt 1 fails its version check and the clock then moves to 120,000 ms, the apply gets the deadline answer, not 409, with 2 apply attempt spans', async () => {
    arrive();

    const raced = racingDb(
      service.db,
      sql(
        "UPDATE ontology_1_objects.engagement SET title = 'Renamed', __version = __version + 1 WHERE engagement_id = 'eng-2'",
      ),
      1,
    );

    const watched = watchedDb(raced.db, {
      failed: () => {
        at(120_000);
      },
    });

    expect(answerOf(await setStatus('eng-2', 'won', watched.db))).toEqual(PAST_DEADLINE);

    expect(watched.transactions()).toBe(1);

    const attempts = (await routeSpans())
      .filter((span) => span.name === 'apply attempt')
      .map((span) => ({
        attempt: span.attributes['apply.attempt'],
        errorType: span.attributes['error.type'],
        status: span.status.code,
      }));

    expect(attempts).toEqual([
      { attempt: 1, errorType: 'ObjectChanged', status: SpanStatusCode.ERROR },
      { attempt: 2, errorType: 'ActionDeadlineExceeded', status: SpanStatusCode.ERROR },
    ]);

    expect(await statusOf('eng-2')).toBe('open');

    expect(await entries()).toBe(0);
  });

  it('service/observability#traces: an attempt that the version check stops and an attempt that the deadline stops each hold apply.object_edits 1', async () => {
    arrive();

    const raced = racingDb(
      service.db,
      sql(
        "UPDATE ontology_1_objects.engagement SET title = 'Renamed', __version = __version + 1 WHERE engagement_id = 'eng-2'",
      ),
      1,
    );

    const watched = watchedDb(raced.db, {
      failed: () => {
        at(120_000);
      },
    });

    expect(answerOf(await setStatus('eng-2', 'won', watched.db))).toEqual(PAST_DEADLINE);

    const attempts = (await routeSpans())
      .filter((span) => span.name === 'apply attempt')
      .map((span) => ({
        errorType: span.attributes['error.type'],
        objectEdits: span.attributes['apply.object_edits'],
      }));

    expect(attempts).toEqual([
      { errorType: 'ObjectChanged', objectEdits: 1 },
      { errorType: 'ActionDeadlineExceeded', objectEdits: 1 },
    ]);
  });
});

describe('the check before step 4 of an apply', () => {
  const probe = (engagementId: string) => ({
    parameters: { account: 'acc-1', engagementId, mode: 'blind-edit', delayMs: 0 },
    options: EXECUTE_NONE,
  });

  it('ontology/action-types/action-types#apply: a request aborted with a disconnect signal and a request past its deadline write nothing, and a write that waits on a row lock ends at the deadline', async () => {
    const aborted = new AbortController();
    const abortingDb = watchedDb(service.db, { read: () => aborted.abort() });

    expect(answerOf(await setStatus('eng-2', 'won', abortingDb.db, aborted.signal))).toEqual(ABORTED);

    expect(abortingDb.transactions()).toBe(0);

    arrive();

    const late = watchedDb(service.db, { ran: () => at(120_000) });

    expect(answerOf(await service.apply(PROBE_VERSION_CHECK, probe('eng-2'), { db: late.db }))).toEqual(PAST_DEADLINE);

    expect(late.transactions()).toBe(0);

    const held = await holder();

    try {
      await held.query("SELECT 1 FROM ontology_1_objects.engagement WHERE engagement_id = 'eng-2' FOR UPDATE");

      vi.useRealTimers();

      arrive();

      const slow = watchedDb(service.db, { ran: () => at(119_500) });
      const started = performance.now();

      expect(answerOf(await service.apply(PROBE_VERSION_CHECK, probe('eng-2'), { db: slow.db }))).toEqual(
        PAST_DEADLINE,
      );

      const elapsed = performance.now() - started;

      expect(elapsed).toBeGreaterThanOrEqual(400);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await held.query('COMMIT');

      await held.end();
    }

    expect(await statusOf('eng-2')).toBe('open');

    expect(await entries()).toBe(0);
  });
});
