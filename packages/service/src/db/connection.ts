import type pg from 'pg';
import QueryStream from 'pg-query-stream';
import { attempt, caught, invariant, settle, type AsyncFallible } from '../errors/index.ts';
import { span, sqlTemplate } from '../spans/index.ts';
import { causeOf, commitFailure, ENDED, inside, withCause, type Connection } from './failure.ts';
import type { Db, DbFailure, Sql } from './types.ts';

export async function* connect(pool: pg.Pool): AsyncFallible<Connection, DbFailure> {
  const client = yield* attempt(
    () => span('sql connection wait', {}, () => pool.connect()),
    (error) => ({ kind: 'unavailable', error }) as const,
  );

  let broken: Error | undefined;

  const onError = (error: Error) => {
    broken ??= error;
  };

  client.on('error', onError);

  return {
    client,
    broken: () => broken,
    release: (drop) => {
      client.off('error', onError);

      client.release(drop || broken !== undefined);
    },
  };
}

function statementAttributes(sql: Sql, held: boolean) {
  const template = sqlTemplate(sql);

  return held ? { 'sql.template': template, 'sql.held': true } : { 'sql.template': template };
}

export function statement<Row extends object>(
  client: pg.PoolClient,
  sql: Sql,
  held: boolean,
  failure: (error: unknown) => DbFailure,
): AsyncFallible<Row[], DbFailure> {
  return attempt(
    () =>
      span(
        'sql',
        () => statementAttributes(sql, held),
        async () => {
          const result = (await client.query<Row>(sql.text, [...sql.values])) as
            pg.QueryResult<Row> | pg.QueryResult<Row>[];

          return (Array.isArray(result) ? result.at(-1) : result)?.rows ?? [];
        },
      ),
    failure,
  );
}

export async function* rows<Row extends object>(
  connection: Connection,
  sql: Sql,
  held: boolean,
): AsyncGenerator<Row, DbFailure | undefined, undefined> {
  const cursor = new CursorStream(sql, connection);

  const read = span(
    'sql',
    () => statementAttributes(sql, held),
    () => connection.client.query(cursor) as AsyncIterable<Row>,
  )[Symbol.asyncIterator]();

  let ended = false;

  try {
    for (;;) {
      const step = await caught(() => read.next());

      if (!step.ok) {
        ended = true;

        return { kind: 'refused', error: causeOf(connection, step.error) };
      }

      if (step.value.done) {
        ended = true;

        return undefined;
      }

      yield step.value.value;
    }
  } finally {
    if (!ended) await caught(async () => read.return?.());
  }
}

const CURSOR_BATCH_SIZE = 1_000;

class CursorStream extends QueryStream {
  readonly #connection: Connection;

  constructor(sql: Sql, connection: Connection) {
    super(sql.text, [...sql.values], { batchSize: CURSOR_BATCH_SIZE });

    this.#connection = connection;
  }

  override _destroy(error: Error, callback: (error?: Error | null) => void): void {
    if (this.#connection.broken() !== undefined) {
      callback(error);

      return;
    }

    const { client } = this.#connection;
    let settled = false;

    const finish = (closeError?: Error | null) => {
      if (settled) return;

      settled = true;

      client.off('end', onEnd);

      callback(closeError ?? error);
    };

    const onEnd = () => finish(error);

    client.once('end', onEnd);

    super._destroy(error, finish);
  }
}

export async function* poolStream<Row extends object>(
  pool: pg.Pool,
  sql: Sql,
): AsyncGenerator<Row, DbFailure | undefined, undefined> {
  const opened = await settle(connect(pool));

  if (!opened.ok) return opened.error;

  const connection = opened.value;
  let read = false;

  try {
    const failure = yield* rows<Row>(connection, sql, false);

    read = failure === undefined;

    return failure;
  } finally {
    connection.release(!read);
  }
}

const COMMIT: Sql = { text: 'COMMIT', values: [] };
const ROLLBACK: Sql = { text: 'ROLLBACK', values: [] };
const NESTED = 'A transaction is already open on this Db.';

// oxlint-disable-next-line require-yield -- a nested transaction is a defect when it runs, not when it is called.
export async function* nested(): AsyncFallible<never, never> {
  invariant(false, NESTED);
}

export async function* inTransaction<T, E>(
  pool: pg.Pool,
  begin: string,
  run: (tx: Db) => AsyncFallible<T, E>,
): AsyncFallible<T, E | DbFailure> {
  const connection = yield* connect(pool);
  const { client } = connection;
  const tx = transactionDb(connection);
  let open = true;

  try {
    yield* statement(client, { text: begin, values: [] }, true, inside(connection));

    const ran = await settle(run(tx.db));

    tx.close();

    if (!ran.ok) {
      await settle(statement(client, ROLLBACK, true, inside()));

      open = false;

      return yield withCause(connection, ran.error);
    }

    const ended = connection.broken() !== undefined;

    yield* statement(client, COMMIT, true, (error) => commitFailure(connection, ended, error));

    open = false;

    return ran.value;
  } finally {
    tx.close();

    if (open) await settle(statement(client, ROLLBACK, true, inside()));

    connection.release(false);
  }
}

function transactionDb(connection: Connection): { db: Db; close: () => void } {
  let open = true;

  const db: Db = {
    async *query<Row extends object>(sql: Sql): AsyncFallible<Row[], DbFailure> {
      invariant(open, ENDED);

      return yield* statement<Row>(connection.client, sql, true, inside());
    },
    async *stream<Row extends object>(sql: Sql): AsyncGenerator<Row, DbFailure | undefined, undefined> {
      invariant(open, ENDED);

      return yield* rows<Row>(connection, sql, true);
    },
    transaction: nested,
    snapshot: nested,
  };

  return {
    db,
    close: () => {
      open = false;
    },
  };
}
