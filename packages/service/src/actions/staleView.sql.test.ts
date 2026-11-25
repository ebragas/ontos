import type { OntologyIr } from '@osdk/client.unstable';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { quoteName } from '../db/index.ts';
import { tableName } from '../ontology/index.ts';
import { convertOrThrow, grantsOf, stored, unchecked } from '../ontology/stored.test-utils.ts';

import type { PublishResponse } from '../publish/index.ts';
import { APPLY, PUBLISHER, publishOntology, readRequest, refusal } from '../publish/publish.test-utils.ts';
import {
  racingDb,
  recordingDb,
  rowsOf,
  seedClient,
  startActions,
  twinFunctions,
  twinIr,
  errorAnswer,
  NS,
  ONTOLOGY_RID,
  type ActionsService,
  type Answer,
} from './actions.test-utils.ts';

type RequestDb = ActionsService['db'];

const ENGAGEMENT = `${NS}Engagement`;
const SET_ENGAGEMENT_STATUS = `${NS}set-engagement-status`;
const EXECUTE_NONE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };
const ENGAGEMENTS = `${quoteName('ontology_1_objects')}.${quoteName(tableName(ENGAGEMENT))}`;
const ACCOUNT = `${NS}Account`;
const ACCOUNTS = `${quoteName('ontology_1_objects')}.${quoteName(tableName(ACCOUNT))}`;
const CLOSE_ACCOUNT_ACTION = `${NS}close-account-action`;

const REGISTRY_ROW = {
  text: 'SELECT version FROM ontology_registry.ontologies WHERE rid = $1',
  values: [ONTOLOGY_RID],
};

const OBJECT_CHANGED = { status: 409, body: { errorCode: 'CONFLICT', errorName: 'ObjectChanged', parameters: {} } };

let service: ActionsService;
let publisher: pg.Client;
let servedVersion: number;

beforeAll(async () => {
  service = await startActions(twinIr('0.6.3'), twinFunctions('0.6.3'));

  publisher = new pg.Client({ connectionString: service.url });

  await publisher.connect();

  const [row] = await service.db.query<{ version: number }>(REGISTRY_ROW);

  servedVersion = row?.version ?? 0;
});

afterAll(async () => {
  await publisher?.end();

  await service?.stop();
});

beforeEach(async () => {
  await service.clear();

  await seedClient(service.db);
});

afterEach(async () => {
  await publisher.query('ROLLBACK');

  await service.db.query({
    text: 'UPDATE ontology_registry.ontologies SET version = $2 WHERE rid = $1',
    values: [ONTOLOGY_RID, servedVersion],
  });
});

async function publishLocks(table = ENGAGEMENTS): Promise<void> {
  await publisher.query('BEGIN');

  await publisher.query({
    text: 'SELECT 1 FROM ontology_registry.ontologies WHERE rid = $1 FOR UPDATE',
    values: [ONTOLOGY_RID],
  });

  await publisher.query(`LOCK TABLE ${table} IN SHARE MODE`);
}

async function publishCommits(): Promise<void> {
  await publisher.query({
    text: 'UPDATE ontology_registry.ontologies SET version = version + 1 WHERE rid = $1',
    values: [ONTOLOGY_RID],
  });

  await publisher.query('COMMIT');
}

async function lockWaitOnEngagements(table = ENGAGEMENTS): Promise<void> {
  for (let tries = 0; tries < 250; tries += 1) {
    const [row] = await service.db.query<{ waiting: number }>({
      text: 'SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted AND relation = $1::regclass',
      values: [table],
    });

    if ((row?.waiting ?? 0) > 0) return;

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`No session waited for a lock on ${table}.`);
}

function publishStatusValueType(): Promise<PublishResponse> {
  const ir = twinIr('0.6.3');

  const constraint = {
    type: 'string',
    string: { type: 'oneOf', oneOf: { values: ['open', 'won', 'lost'], useIgnoreCase: false } },
  };

  const definition = {
    metadata: {
      apiName: 'engagementStatus',
      displayMetadata: { displayName: 'Engagement status', description: '' },
      status: { type: 'active', active: {} },
    },
    versions: [
      {
        version: '1.0.0',
        baseType: { type: 'string', string: {} },
        constraints: [{ constraint: { constraint } }],
        exampleValues: [],
      },
    ],
  };

  const status = ir.ontology.objectTypes[ENGAGEMENT]?.objectType.propertyTypes['status'];

  if (!status) throw new Error('The twin 0.6.3 IR has no Engagement status.');

  Object.assign(
    status,
    unchecked({
      valueType: { apiName: 'engagementStatus', version: '1.0.0' },
      dataConstraints: { propertyTypeConstraints: [{ constraints: constraint }] },
    }),
  );

  const typed: OntologyIr = { ...ir, valueTypes: unchecked({ valueTypes: [definition] }) };

  const body = {
    ir: typed,
    product: 'twin',
    schemaMigrations: { migrations: [] },
    osdkSet: stored(typed).osdkSet,
    grants: grantsOf(typed),
    validateOnly: false,
    functions: twinFunctions('0.6.3'),
  };

  const request = readRequest(JSON.parse(JSON.stringify(body)) as Parameters<typeof readRequest>[0]);

  return publishOntology(service.db, {
    product: 'twin',
    productRid: ONTOLOGY_RID,
    ontology: convertOrThrow(request, ONTOLOGY_RID, servedVersion + 1),
    request,
    publisher: PUBLISHER,
    mode: APPLY,
  });
}

const setStatus = (status: string, db: RequestDb) =>
  service.apply(
    SET_ENGAGEMENT_STATUS,
    { parameters: { objectToModifyParameter: 'eng-2', status }, options: EXECUTE_NONE },
    { db },
  );

const answerOf = (answer: Answer) => (answer.status === 200 ? answer : errorAnswer(answer));

const statusOfEng2 = async () =>
  (await rowsOf(service.db, ENGAGEMENT, 'engagement_id')).find((row) => row['engagement_id'] === 'eng-2')?.['status'];

const writesObjectTable = (statement: string) =>
  /^(INSERT INTO|UPDATE|DELETE FROM|WITH deleted)/.test(statement) && statement.includes('ontology_1_objects');

describe('a publish that changes the Object table while an apply writes it', () => {
  it('service/storage#writes: the publish locks the table first: the UPDATE of the apply waits, the publish commits, and the apply gets 409 ObjectChanged and writes nothing', async () => {
    await publishLocks();

    const applied = setStatus('won', service.db);

    await lockWaitOnEngagements();

    await publishCommits();

    expect(answerOf(await applied)).toEqual(OBJECT_CHANGED);

    expect(await statusOfEng2()).toBe('open');
  });

  it('service/storage#writes: the apply locks the table first: the publish waits for its commit, and then checks the written value under its lock, so a value that the new version refuses fails the publish', async () => {
    const wrote = Promise.withResolvers<undefined>();
    const publishWaits = Promise.withResolvers<undefined>();

    const recorded = recordingDb(service.url, async (statement) => {
      if (!(statement.startsWith('UPDATE') && statement.includes(ENGAGEMENTS))) return;

      wrote.resolve(undefined);

      await publishWaits.promise;
    });

    try {
      const applied = setStatus('paused', recorded.db);

      await wrote.promise;

      const published = refusal(publishStatusValueType());

      await lockWaitOnEngagements();

      publishWaits.resolve(undefined);

      expect(answerOf(await applied)).toMatchObject({ status: 200 });

      const error = await published;

      expect([error.status, error.errorName, error.parameters['valueType'], error.parameters['primaryKeys']]).toEqual([
        400,
        'Default:InvalidArgument',
        'engagementStatus',
        ['eng-2'],
      ]);
    } finally {
      await recorded.pool.end();
    }

    expect(await statusOfEng2()).toBe('paused');

    const [row] = await service.db.query<{ version: number }>(REGISTRY_ROW);

    expect(row?.version).toBe(servedVersion);
  });

  it('service/storage#writes: the publish commits before the write transaction opens: the apply gets 409 ObjectChanged and writes nothing', async () => {
    const raced = racingDb(
      service.db,
      async () => {
        await publishLocks();

        await publishCommits();
      },
      1,
    );

    expect(answerOf(await setStatus('won', raced.db))).toEqual(OBJECT_CHANGED);

    expect(await statusOfEng2()).toBe('open');
  });
});

describe('the version read of the write transaction', () => {
  it('service/storage#writes: the write transaction runs in READ COMMITTED, and the version read is its last statement, after the last statement that writes the Object table', async () => {
    const recorded = recordingDb(service.url);

    try {
      expect(answerOf(await setStatus('won', recorded.db))).toMatchObject({ status: 200 });
    } finally {
      await recorded.pool.end();
    }

    const begin = recorded.statements.indexOf('BEGIN ISOLATION LEVEL READ COMMITTED');
    const commit = recorded.statements.indexOf('COMMIT');

    expect(begin).toBeGreaterThanOrEqual(0);

    const transaction = recorded.statements.slice(begin + 1, commit);

    expect(transaction.at(-1)).toBe(REGISTRY_ROW.text);
    expect(transaction.findLastIndex(writesObjectTable)).toBeGreaterThanOrEqual(0);
  });
});

describe('a rule-backed Action whose view is older than the served version', () => {
  it('ontology/action-types/action-types#apply: the Action does not run again inside the service after 409 ObjectChanged from a changed version', async () => {
    const raced = racingDb(
      service.db,
      async () => {
        await publishLocks();

        await publishCommits();
      },
      1,
    );

    expect(answerOf(await setStatus('won', raced.db))).toEqual(OBJECT_CHANGED);

    expect(raced.transactions()).toBe(1);

    expect(await statusOfEng2()).toBe('open');
  });
});

describe('a function-backed Action whose view is older than the served version', () => {
  it('ontology/action-types/action-types#apply: the publish locks the Account table first: the write of the apply waits, the publish commits, and the apply gets 409 ObjectChanged and writes nothing', async () => {
    await publishLocks(ACCOUNTS);

    const applied = service.apply(CLOSE_ACCOUNT_ACTION, { parameters: { account: 'acc-1' }, options: EXECUTE_NONE });

    await lockWaitOnEngagements(ACCOUNTS);

    await publishCommits();

    expect(answerOf(await applied)).toEqual(OBJECT_CHANGED);

    const accounts = await rowsOf(service.db, ACCOUNT, 'account_id');

    expect(accounts.find((row) => row['account_id'] === 'acc-1')?.['phase']).toBe('customer');
  });
});
