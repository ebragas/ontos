import type pg from 'pg';
import { attempt, caught, invariant, settle, type AsyncFallible } from '../errors/index.ts';
import { connect, nested, rows, statement } from './connection.ts';
import { commitFailure, ENDED, inside, withCause, type Connection } from './failure.ts';
import type { Db, DbFailure, SnapshotDb, Sql } from './types.ts';

const COMMIT: Sql = { text: 'COMMIT', values: [] };
const ROLLBACK: Sql = { text: 'ROLLBACK', values: [] };
const BEGIN_SNAPSHOT: Sql = { text: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', values: [] };

const BEGIN_AND_EXPORT_SNAPSHOT: Sql = {
  text: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot() AS snapshot',
  values: [],
};

const SNAPSHOT_ID = /^[0-9a-fA-F]+-[0-9a-fA-F]+-\d+$/;
const MAX_SNAPSHOT_CONNECTIONS = 4;

interface SnapshotSlot {
  readonly connection: Connection;
  readonly primary: boolean;
  busy: boolean;
  broken: boolean;
}

export async function* inSnapshot<T, E>(
  pool: pg.Pool,
  run: (tx: SnapshotDb) => AsyncFallible<T, E>,
): AsyncFallible<T, E | DbFailure> {
  const primaryConnection = yield* connect(pool);
  const primary: SnapshotSlot = { connection: primaryConnection, primary: true, busy: false, broken: false };
  const slots: SnapshotSlot[] = [primary];
  let primaryOpen = false;
  let primaryDrop = false;
  let siblingsClosed = false;
  let handle: { readonly db: SnapshotDb; readonly closeAndDrainOpening: () => Promise<void> } | undefined;

  try {
    const exported = await settle(
      statement<{ snapshot: unknown }>(
        primaryConnection.client,
        BEGIN_AND_EXPORT_SNAPSHOT,
        true,
        inside(primaryConnection),
      ),
    );

    if (!exported.ok) {
      primaryDrop = true;

      return yield exported.error;
    }

    primaryOpen = true;

    const snapshotId = exported.value[0]?.snapshot;

    invariant(
      typeof snapshotId === 'string' && SNAPSHOT_ID.test(snapshotId),
      'Postgres returned an invalid snapshot identifier.',
    );

    const snapshot = snapshotDb(pool, primary, slots, snapshotId);

    handle = snapshot;

    const ran = await settle(run(snapshot.db));

    await caught(() => snapshot.closeAndDrainOpening());

    if (!ran.ok) {
      await caught(() => closeSiblings(slots, false));

      siblingsClosed = true;

      if (!primary.busy && primaryConnection.broken() === undefined) {
        const rolledBack = await settle(statement(primaryConnection.client, ROLLBACK, true, inside()));

        if (!rolledBack.ok) primaryDrop = true;
      }

      primaryOpen = false;

      return yield withCause(primaryConnection, ran.error);
    }

    const ended = primaryConnection.broken() !== undefined;
    const closing = caught(() => closeSiblings(slots, true));

    const committed = primary.busy
      ? { ok: true as const, value: [] }
      : await settle(
          statement(primaryConnection.client, COMMIT, true, (error) => commitFailure(primaryConnection, ended, error)),
        );

    await caught(() => closing);

    siblingsClosed = true;

    primaryOpen = false;

    if (!committed.ok) {
      primaryDrop = true;

      return yield committed.error;
    }

    return ran.value;
  } finally {
    if (handle !== undefined) await caught(handle.closeAndDrainOpening);

    if (!siblingsClosed) await caught(() => closeSiblings(slots, false));

    if (primaryOpen && !primary.busy && primaryConnection.broken() === undefined) {
      const rolledBack = await settle(statement(primaryConnection.client, ROLLBACK, true, inside()));

      if (!rolledBack.ok) primaryDrop = true;
    }

    primaryConnection.release(primaryDrop || primary.busy);
  }
}

async function closeSiblings(slots: readonly SnapshotSlot[], commit: boolean): Promise<void> {
  const siblings = slots.filter((slot) => !slot.primary);

  if (siblings.length === 0) return;

  await caught(() =>
    Promise.all(
      siblings.map(async (slot) => {
        if (slot.busy || slot.connection.broken() !== undefined) {
          slot.connection.release(true);

          return;
        }

        const endSql = commit && !slot.broken ? COMMIT : ROLLBACK;

        const ended = await settle(statement(slot.connection.client, endSql, true, inside()));

        slot.connection.release(!ended.ok);
      }),
    ),
  );
}

function snapshotDb(
  pool: pg.Pool,
  primary: SnapshotSlot,
  slots: SnapshotSlot[],
  snapshotId: string,
): { readonly db: SnapshotDb; readonly closeAndDrainOpening: () => Promise<void> } {
  const poolMax = pool.options.max ?? 10;
  const maxConnections = Math.min(MAX_SNAPSHOT_CONNECTIONS, Math.max(1, poolMax));
  const setSnapshotSql: Sql = { text: `SET TRANSACTION SNAPSHOT '${snapshotId}'`, values: [] };
  const queue: ((slot: SnapshotSlot | undefined) => void)[] = [];
  const opening = new Set<Promise<unknown>>();
  let open = true;
  let siblingsDisabled = false;

  const findIdle = (): SnapshotSlot | undefined =>
    slots.find((slot) => !slot.busy && !slot.broken && slot.connection.broken() === undefined) ??
    (!primary.busy ? primary : undefined);

  const canOpenSibling = (): boolean =>
    open &&
    !siblingsDisabled &&
    !primary.broken &&
    primary.connection.broken() === undefined &&
    slots.length + opening.size < maxConnections &&
    pool.idleCount + Math.max(0, poolMax - pool.totalCount) > pool.waitingCount;

  async function openSibling(): Promise<SnapshotSlot | undefined> {
    let connection: Connection | undefined;
    let begun = false;
    let drop = false;

    try {
      const connected = await settle(connect(pool));

      if (!connected.ok) return undefined;

      connection = connected.value;

      if (!open) return undefined;

      const started = await settle(statement(connection.client, BEGIN_SNAPSHOT, true, inside(connection)));

      if (!started.ok) {
        drop = true;

        return undefined;
      }

      begun = true;

      if (!open) return undefined;

      const imported = await settle(statement(connection.client, setSnapshotSql, true, inside(connection)));

      if (!imported.ok) {
        if (open) siblingsDisabled = true;

        return undefined;
      }

      if (!open) return undefined;

      const slot: SnapshotSlot = { connection, primary: false, busy: true, broken: false };

      slots.push(slot);

      connection = undefined;

      return slot;
    } finally {
      if (connection !== undefined) {
        if (begun && connection.broken() === undefined) {
          const rolledBack = await settle(statement(connection.client, ROLLBACK, true, inside()));

          if (!rolledBack.ok) drop = true;
        }

        connection.release(drop || connection.broken() !== undefined);
      }
    }
  }

  async function* acquireSlot(): AsyncFallible<SnapshotSlot, DbFailure> {
    invariant(open, ENDED);

    const idleSlot = findIdle();

    if (idleSlot) {
      idleSlot.busy = true;

      return idleSlot;
    }

    if (canOpenSibling()) {
      const pending = openSibling();

      opening.add(pending);

      const opened = await caught(async () => {
        try {
          return await pending;
        } finally {
          opening.delete(pending);
        }
      });

      invariant(open, ENDED);

      if (opened.ok && opened.value !== undefined) return opened.value;

      const freed = findIdle();

      if (freed) {
        freed.busy = true;

        return freed;
      }
    }

    const slot = yield* attempt(
      () =>
        new Promise<SnapshotSlot | undefined>((resolve) => {
          queue.push(resolve);
        }),
      inside(),
    );

    invariant(open && slot !== undefined, ENDED);

    return slot;
  }

  function releaseSlot(slot: SnapshotSlot): void {
    slot.busy = false;

    if (!open) return;

    if (!slot.primary && (slot.broken || slot.connection.broken() !== undefined)) return;

    const next = queue.shift();

    if (next) {
      slot.busy = true;

      next(slot);
    }
  }

  const db: Db = {
    async *query<Row extends object>(sql: Sql): AsyncFallible<Row[], DbFailure> {
      const slot = yield* acquireSlot();

      try {
        const ran = await settle(statement<Row>(slot.connection.client, sql, true, inside(slot.connection)));

        if (!ran.ok) {
          slot.broken = true;

          return yield ran.error;
        }

        return ran.value;
      } finally {
        if (slot.connection.broken() !== undefined) slot.broken = true;

        releaseSlot(slot);
      }
    },
    async *stream<Row extends object>(sql: Sql): AsyncGenerator<Row, DbFailure | undefined, undefined> {
      const acquired = await settle(acquireSlot());

      if (!acquired.ok) return acquired.error;

      const slot = acquired.value;

      try {
        const failure = yield* rows<Row>(slot.connection, sql, true);

        if (failure !== undefined) slot.broken = true;

        return failure;
      } finally {
        if (slot.connection.broken() !== undefined) slot.broken = true;

        releaseSlot(slot);
      }
    },
    transaction: nested,
    snapshot: nested,
  };

  return {
    db: db as SnapshotDb,
    closeAndDrainOpening: async () => {
      open = false;

      while (queue.length > 0) queue.shift()?.(undefined);

      if (opening.size > 0) await caught(() => Promise.allSettled([...opening]));
    },
  };
}
