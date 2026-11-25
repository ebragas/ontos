import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '../db/promise.test-utils.ts';
import {
  errorAnswer,
  NS,
  rowsOf,
  seedClient,
  startActions,
  twinFunctions,
  twinIr,
  type ActionsService,
  type Answer,
} from './actions.test-utils.ts';

const ENGAGEMENT = `${NS}Engagement`;
const SET_ENGAGEMENT_STATUS = `${NS}set-engagement-status`;
const EXECUTE_NONE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };

let service: ActionsService;

beforeAll(async () => {
  service = await startActions(twinIr('0.6.3'), twinFunctions('0.6.3'));
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  await seedClient(service.db);
});

function commitFails(failure: Error, ends: boolean): { readonly db: Db; readonly pool: pg.Pool } {
  const pool = createPool(service.url, { max: 1 });
  const connect = pool.connect.bind(pool);
  let armed = true;

  const patched = async () => {
    const client = await connect();

    const query = client.query.bind(client) as (text: unknown, values?: unknown) => Promise<unknown>;

    const failing = async (text: unknown, values?: unknown) => {
      if (text !== 'COMMIT' || !armed) return query(text, values);

      armed = false;

      await query(text);

      if (!ends) return Promise.reject(failure);

      client.emit('error', failure);

      return Promise.reject(new Error('Connection terminated unexpectedly'));
    };

    return Object.assign(client, { query: failing });
  };

  return { db: createDb(Object.assign(pool, { connect: patched })), pool };
}

function refusedWith(
  part: string,
  code: string,
): { readonly db: Db; readonly pool: pg.Pool; readonly refused: () => number } {
  const pool = createPool(service.url, { max: 1 });
  const connect = pool.connect.bind(pool);
  let refused = 0;

  const patched = async () => {
    const client = await connect();

    const query = client.query.bind(client) as (text: unknown, values?: unknown) => Promise<unknown>;

    const refusing = async (text: unknown, values?: unknown) => {
      if (typeof text !== 'string' || !text.includes(part)) return query(text, values);

      refused += 1;

      return query(`DO $$ BEGIN RAISE EXCEPTION 'refused by the test' USING ERRCODE = '${code}'; END $$`);
    };

    return Object.assign(client, { query: refusing });
  };

  return { db: createDb(Object.assign(pool, { connect: patched })), pool, refused: () => refused };
}

const setStatus = (status: string, db: Db) =>
  service.apply(
    SET_ENGAGEMENT_STATUS,
    { parameters: { objectToModifyParameter: 'eng-2', status }, options: EXECUTE_NONE },
    { db },
  );

const answerOf = (answer: Answer) => (answer.status === 200 ? answer : errorAnswer(answer));

const statusOfEng2 = async () =>
  (await rowsOf(service.db, ENGAGEMENT, 'engagement_id')).find((row) => row['engagement_id'] === 'eng-2')?.['status'];

const INTERNAL = { status: 500, body: { errorCode: 'INTERNAL', errorName: 'Default:Internal', parameters: {} } };
const coded = (code: string) => Object.assign(new Error(`The server ended the session (${code}).`), { code });

describe('a statement that Postgres refuses with a code', () => {
  it('service/storage#writes: a deadlock, 40P01, on each lock of the Object gives ObjectChanged, so the rule-backed Action runs again, and then answers 409 ObjectChanged and writes nothing', async () => {
    const { db, pool, refused } = refusedWith('FOR UPDATE', '40P01');

    try {
      expect(answerOf(await setStatus('won', db))).toEqual({
        status: 409,
        body: { errorCode: 'CONFLICT', errorName: 'ObjectChanged', parameters: {} },
      });

      expect(refused()).toBeGreaterThan(1);

      expect(await statusOfEng2()).toBe('open');
    } finally {
      await pool.end();
    }
  });
});

describe('a COMMIT that applies and then fails', () => {
  it('service/storage#writes: a connection that drops after the COMMIT applied gives 500, not a refusal, and the edit is written', async () => {
    const { db, pool } = commitFails(new Error('Connection terminated unexpectedly'), false);

    try {
      expect(answerOf(await setStatus('won', db))).toEqual(INTERNAL);

      expect(await statusOfEng2()).toBe('won');
    } finally {
      await pool.end();
    }
  });

  it('service/storage#writes: a session that the server ends with 57P01 after the COMMIT applied gives 500, and the edit is written', async () => {
    const { db, pool } = commitFails(coded('57P01'), true);

    try {
      expect(answerOf(await setStatus('won', db))).toEqual(INTERNAL);

      expect(await statusOfEng2()).toBe('won');
    } finally {
      await pool.end();
    }
  });
});
