import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool, quoteName } from '../db/index.ts';
import { createDb, fallibleOf } from '../db/promise.test-utils.ts';
import { handle, type FaultFields, type HandleInput } from '../handler/index.ts';
import { tableName } from '../ontology/index.ts';
import { grantsOf, NS, ONTOLOGY_RID, stored, irOf, twinBlock } from '../ontology/stored.test-utils.ts';
import { installOnce } from '../install.test-utils.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { insertObjects, newDatabase, onNewConnection, type TestDatabase } from '../publish/publish.test-utils.ts';
import { roleUsers } from '../people.test-utils.ts';
import { readerOf } from '../service.test-utils.ts';
import { createTestIssuer } from '../tokens.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';

const ENGAGEMENT = `${NS}Engagement`;
const IR = irOf(twinBlock('0.7.0', `${NS}Account`), twinBlock('0.7.0', ENGAGEMENT));
const APP = { repository: 'example/twin', environment: 'publish' };

const settings = {
  productRid: ONTOLOGY_RID,
  environment: 'test',
  auth: { workosClientId: 'c14', baseUrl: 'http://localhost', app: APP },
};

const AGGREGATE = 'POST /api/v2/ontologies/{ontology}/objectSets/aggregate';

let postgres: TestPostgres;
let database: TestDatabase;
let pool: ReturnType<typeof createPool>;
let input: HandleInput;
let token: string;
const faults: { error: unknown; fields: FaultFields }[] = [];
const pending: Promise<void>[] = [];

beforeAll(async () => {
  postgres = await startPostgres();

  database = await newDatabase(postgres.url);

  pool = createPool(database.url);

  const db = createDb(pool);

  const issuer = await createTestIssuer(settings.auth);

  input = {
    db: fallibleOf(db),
    directDb: fallibleOf(db),
    settings,
    keys: issuer.keys,
    users: roleUsers(grantsOf(IR).defaultRoles),
    workos: stubPublish(),
    reportFault: (error, fields) => void faults.push({ error, fields }),
    bodyPending: (settled) => void pending.push(settled),
  };

  const publish = await handle(
    new Request('http://localhost/api/ontology-service/v1/publish', {
      method: 'POST',
      headers: { authorization: `Bearer ${await issuer.github()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ir: IR,
        product: 'twin',
        schemaMigrations: { migrations: [] },
        osdkSet: stored(IR).osdkSet,
        grants: grantsOf(IR),
        validateOnly: false,
      }),
    }),
    input,
  );

  await publish.text();

  if (publish.status !== 200) throw new Error(`The publish gave ${publish.status}`);

  await installOnce(db, ONTOLOGY_RID, 'twin');

  token = await issuer.workos();

  const rows = Array.from({ length: 2_500 }, (_, i) => ({
    engagementId: `e-${i}`,
    accountId: 'a',
    title: `t${i}`,
    amount: i,
    status: `s${i}`,
    createdAt: null,
  }));

  await insertObjects(db, ENGAGEMENT, rows);
});

afterAll(async () => {
  await pool?.end();

  await database?.end();

  await postgres?.stop();
});

async function aggregate(): Promise<Response> {
  faults.length = 0;

  pending.length = 0;

  return handle(
    new Request(`http://localhost/api/v2/ontologies/${ONTOLOGY_RID}/objectSets/aggregate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        objectSet: { type: 'base', objectType: ENGAGEMENT },
        groupBy: [{ type: 'exact', field: 'engagementId' }],
        aggregation: [{ type: 'count', name: 'count' }],
      }),
    }),
    input,
  );
}

async function endActiveBackends(): Promise<number> {
  const name = new URL(database.url).pathname.slice(1);

  const killed = await onNewConnection<{ ok: boolean }>(
    postgres.url,
    `SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid() AND state <> 'idle'`,
  );

  return killed.length;
}

async function replay() {
  const logged = vi.spyOn(console, 'log');

  const response = await aggregate();

  const reader = readerOf(response);

  const first = await reader.read();

  const killed = await endActiveBackends();

  await new Promise((r) => setTimeout(r, 300));

  let text = new TextDecoder().decode(first.value);
  let failure: unknown;

  try {
    for (;;) {
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, no) => setTimeout(() => no(new Error('read hung')), 10_000)),
      ]);

      if (next.done) break;

      text += new TextDecoder().decode(next.value);
    }
  } catch (error) {
    failure = error;
  }

  await Promise.all(pending);

  const lines = logged.mock.calls.map((call) => String(call[0]));

  logged.mockRestore();

  return { status: response.status, killed, failure, text, lines };
}

describe('the database ends the cursor of an aggregate after the first chunk', () => {
  it('service/http-api#errors (a): the client gets status 200 and a clear failure, not a body that looks complete', async () => {
    const run = await replay();

    expect(run.killed).toBeGreaterThan(0);
    expect(run.status).toBe(200);
    expect(run.failure).toBeInstanceOf(Error);
    expect((run.failure as Error).message).not.toBe('read hung');
  });

  it('service/observability#error-reports (b): the service reports the fault once, with the route, the Ontology version, and the user ID, and no errorInstanceId', async () => {
    const run = await replay();

    expect(run.killed).toBeGreaterThan(0);
    expect(run.failure).toBeInstanceOf(Error);
    expect(faults).toHaveLength(1);

    expect(faults[0]?.fields).toEqual({
      errorName: 'Default:Internal',
      route: AGGREGATE,
      ontologyVersion: expect.any(Number),
      userId: expect.any(String),
      callerKind: 'person',
      traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      rootSpanId: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
  });

  it('(b2) the service writes an error log line with the stack', async () => {
    const run = await replay();

    expect(run.lines.some((line) => line.includes('"stack"'))).toBe(true);
  });
});

describe('the controls of the replay', () => {
  it('service/observability#error-reports: a fault before the first byte gets 500 and 1 report with its errorInstanceId', async () => {
    const table = `ontology_1_objects.${quoteName(tableName(ENGAGEMENT))}`;
    const moved = quoteName(`${tableName(ENGAGEMENT)}_moved`);
    const logged = vi.spyOn(console, 'log');

    await onNewConnection(database.url, `ALTER TABLE ${table} RENAME TO ${moved}`);

    try {
      const response = await aggregate();

      expect(response.status).toBe(500);

      const { errorInstanceId } = (await response.json()) as { errorInstanceId: string };

      await Promise.all(pending);

      expect(faults.map(({ fields }) => fields)).toEqual([
        expect.objectContaining({ errorInstanceId, errorName: 'Default:Internal', route: AGGREGATE }),
      ]);
    } finally {
      await onNewConnection(
        database.url,
        `ALTER TABLE ontology_1_objects.${moved} RENAME TO ${quoteName(tableName(ENGAGEMENT))}`,
      );

      logged.mockRestore();
    }
  });

  it('service/observability#error-reports: a client that stops reading after the first chunk gets no report', async () => {
    const logged = vi.spyOn(console, 'log');

    const response = await aggregate();

    const reader = readerOf(response);

    expect((await reader.read()).done).toBe(false);

    await reader.cancel();

    await Promise.all(pending);

    logged.mockRestore();

    expect(pending).toHaveLength(1);
    expect(faults).toEqual([]);
  });
});
