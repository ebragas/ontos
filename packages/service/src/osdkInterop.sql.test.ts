import type { Server } from 'node:http';
import { createClient, type Client } from '@osdk/client';
import type { OntologyIr } from '@osdk/client.unstable';
import { ObjectTypesV2 } from '@osdk/foundry.ontologies';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from './db/index.ts';
import { applyEngineChanges, createDb, fallibleOf, type Db } from './db/promise.test-utils.ts';
import type { Settings } from './handler/index.ts';
import { installOntology } from './install.test-utils.ts';
import { closeServer, listenLocal } from './localServer.test-utils.ts';
import { createNodeServer } from './node.ts';
import type { GrantsFile } from './ontology/index.ts';
import {
  jobsiteIr,
  NS,
  ONTOLOGY_RID,
  stored,
  twinFunctions,
  twinGrants,
  twinIr,
  unchecked,
} from './ontology/stored.test-utils.ts';
import { claimsOf, roleUsers } from './people.test-utils.ts';
import { startPostgres, type TestPostgres } from './postgres.test-utils.ts';
import type { PublishedFunctions } from './publish/index.ts';
import { onNewConnection } from './publish/publish.test-utils.ts';
import { createTestIssuer, now, ORGANIZATION, type TestIssuer } from './tokens.test-utils.ts';
import { stubPublish } from './workos.test-utils.ts';
import {
  CREW,
  JOBSITE,
  jobsiteGrants,
  jobsiteUsers,
  PEOPLE,
  seedJobsite,
  type Person,
} from '../twin/seed/jobsite.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const CREATE_ACCOUNT = `${NS}create-account`;
const CREATE_ENGAGEMENT = `${NS}create-engagement`;
const SET_ENGAGEMENT_STATUS = `${NS}set-engagement-status`;
const CLOSE_ACCOUNT_ACTION = `${NS}close-account-action`;

const APP = { repository: 'example/twin', environment: 'publish' };

const SETTINGS: Settings = {
  productRid: ONTOLOGY_RID,
  environment: 'osdk-interop',
  auth: { workosClientId: 'osdk-interop', baseUrl: 'http://localhost', app: APP },
};

interface DynamicObjectSet {
  where(clause: Record<string, unknown>): DynamicObjectSet;
  pivotTo(link: string): DynamicObjectSet;
  fetchPage(options?: Record<string, unknown>): Promise<{ data: Record<string, unknown>[]; nextPageToken?: string }>;
  aggregate(query: Record<string, unknown>): Promise<unknown>;
}

interface DynamicAction {
  applyAction(parameters: Record<string, unknown>, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

type DynamicClient = (descriptor: { type: 'object' | 'action'; apiName: string }) => unknown;

function objectSet(client: Client, apiName: string): DynamicObjectSet {
  return unchecked<DynamicObjectSet>(unchecked<DynamicClient>(client)({ type: 'object', apiName }));
}

function actionOf(client: Client, apiName: string): DynamicAction {
  return unchecked<DynamicAction>(unchecked<DynamicClient>(client)({ type: 'action', apiName }));
}

interface LiveServer {
  readonly baseUrl: string;
  readonly db: Db;
  readonly issuer: TestIssuer;
  stop(): Promise<void>;
}

async function serviceRoleUrl(postgres: TestPostgres, tag: string): Promise<string> {
  const roleName = `${postgres.role}_${tag}`;

  await onNewConnection(
    postgres.url,
    `CREATE ROLE ${roleName} LOGIN PASSWORD '${roleName}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );

  await onNewConnection(postgres.url, `GRANT CREATE ON DATABASE ${postgres.role} TO ${roleName}`);

  const url = new URL(postgres.url);

  url.username = roleName;
  url.password = roleName;

  return url.toString();
}

async function startLiveServer(options: {
  readonly tag: string;
  readonly ir: OntologyIr;
  readonly grants: GrantsFile;
  readonly functions?: PublishedFunctions;
  readonly users?: ReturnType<typeof roleUsers>;
}): Promise<LiveServer> {
  const postgres: TestPostgres = await startPostgres();

  const pool: pg.Pool = createPool(await serviceRoleUrl(postgres, options.tag));

  const db = createDb(pool);

  await applyEngineChanges(db);

  const issuer = await createTestIssuer(SETTINGS.auth);

  const server: Server = createNodeServer({
    db: fallibleOf(db),
    directDb: fallibleOf(db),
    settings: SETTINGS,
    keys: issuer.keys,
    users: options.users ?? roleUsers(options.grants.defaultRoles),
    workos: stubPublish(),
  });

  const baseUrl = await listenLocal(server);

  const publishResponse = await fetch(new URL('/api/ontology-service/v1/publish', baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await issuer.github({ exp: now() + 3600 })}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      product: 'twin',
      ir: options.ir,
      ...(options.functions ? { functions: options.functions } : {}),
      schemaMigrations: { migrations: [] },
      osdkSet: stored(options.ir).osdkSet,
      grants: options.grants,
      validateOnly: false,
    }),
  });

  if (publishResponse.status !== 200)
    throw new Error(`Publish failed with ${publishResponse.status}: ${await publishResponse.text()}`);

  await installOntology(db, {
    rid: ONTOLOGY_RID,
    product: 'twin',
    apiName: 'twin',
    displayName: 'Twin',
    organization: ORGANIZATION,
  });

  return {
    baseUrl,
    db,
    issuer,
    stop: async () => {
      await closeServer(server);

      await pool.end();

      await postgres.stop();
    },
  };
}

describe('stock @osdk/client end-to-end interop against Postgres', () => {
  let live: LiveServer;
  let client: Client;

  beforeAll(async () => {
    const ir = twinIr('0.7.0');
    const accountBlock = ir.ontology.objectTypes[ACCOUNT];

    if (!accountBlock) throw new Error(`Twin 0.7.0 IR has no ${ACCOUNT}`);

    unchecked<{ entityMetadata: Record<string, unknown> }>(accountBlock).entityMetadata['editsHistory'] = {
      type: 'config',
      config: { store: ACCOUNT, storeAllPreviousProperties: true },
    };

    live = await startLiveServer({ tag: 'twin', ir, grants: twinGrants('0.7.0'), functions: twinFunctions('0.7.0') });

    const token = await live.issuer.workos({ exp: now() + 3600, ...claimsOf('admin') });

    client = createClient(live.baseUrl, ONTOLOGY_RID, () => Promise.resolve(token));
  }, 60_000);

  afterAll(async () => {
    await live?.stop();
  });

  it('supports rule-backed applyAction, fetchPage with where/paging, pivotTo, aggregate, function-backed applyAction, and editsHistory', async () => {
    const acc1 = await actionOf(client, CREATE_ACCOUNT).applyAction(
      { accountId: 'acc-1', name: 'Acme', phase: 'customer' },
      { $returnEdits: true },
    );

    expect(acc1['addedObjects']).toEqual([{ objectType: ACCOUNT, primaryKey: 'acc-1' }]);

    await actionOf(client, CREATE_ACCOUNT).applyAction({ accountId: 'acc-2', name: 'Globex', phase: 'customer' });

    await actionOf(client, CREATE_ACCOUNT).applyAction({ accountId: 'acc-3', name: 'Initech', phase: 'prospect' });

    await actionOf(client, CREATE_ENGAGEMENT).applyAction({
      engagementId: 'eng-1',
      accountId: 'acc-1',
      title: 'Discovery',
      amount: 12000,
    });

    await actionOf(client, CREATE_ENGAGEMENT).applyAction({
      engagementId: 'eng-2',
      accountId: 'acc-1',
      title: 'Rollout',
      amount: 30000,
    });

    await actionOf(client, SET_ENGAGEMENT_STATUS).applyAction({ objectToModifyParameter: 'eng-2', status: 'won' });

    await actionOf(client, CREATE_ENGAGEMENT).applyAction({
      engagementId: 'eng-3',
      accountId: 'acc-2',
      title: 'Renewal',
      amount: 18000,
    });

    const page1 = await objectSet(client, ACCOUNT)
      .where({ phase: { $eq: 'customer' } })
      .fetchPage({ $pageSize: 1, $orderBy: { name: 'asc' } });

    expect(page1.data.map((row) => row['accountId'])).toEqual(['acc-1']);
    expect(typeof page1.nextPageToken).toBe('string');

    const page2 = await objectSet(client, ACCOUNT)
      .where({ phase: { $eq: 'customer' } })
      .fetchPage({ $pageSize: 1, $orderBy: { name: 'asc' }, $nextPageToken: page1.nextPageToken });

    expect(page2.data.map((row) => row['accountId'])).toEqual(['acc-2']);
    expect(page2.nextPageToken).toBeUndefined();

    const pivoted = await objectSet(client, ACCOUNT)
      .where({ accountId: { $eq: 'acc-1' } })
      .pivotTo('engagements')
      .fetchPage({ $orderBy: { engagementId: 'asc' } });

    expect(pivoted.data.map((row) => [row['engagementId'], row['title']])).toEqual([
      ['eng-1', 'Discovery'],
      ['eng-2', 'Rollout'],
    ]);

    const grouped = (await objectSet(client, ENGAGEMENT).aggregate({
      $select: { $count: 'unordered', 'amount:sum': 'unordered', 'amount:max': 'unordered' },
      $groupBy: { status: 'exact' },
    })) as { $group: { status: string }; $count: number; amount: { sum: number; max: number } }[];

    expect([...grouped].sort((a, b) => a.$group.status.localeCompare(b.$group.status))).toEqual([
      { $group: { status: 'open' }, $count: 2, amount: { sum: 30000, max: 18000 } },
      { $group: { status: 'won' }, $count: 1, amount: { sum: 30000, max: 30000 } },
    ]);

    const closed = await actionOf(client, CLOSE_ACCOUNT_ACTION).applyAction(
      { account: 'acc-1', reason: 'Churned' },
      { $returnEdits: true },
    );

    expect(closed['modifiedObjects']).toEqual(
      expect.arrayContaining([
        { objectType: ACCOUNT, primaryKey: 'acc-1' },
        { objectType: ENGAGEMENT, primaryKey: 'eng-1' },
      ]),
    );

    const afterAccount = await objectSet(client, ACCOUNT)
      .where({ accountId: { $eq: 'acc-1' } })
      .fetchPage();

    expect(afterAccount.data[0]?.['phase']).toBe('closed');

    const afterEngagements = await objectSet(client, ENGAGEMENT)
      .where({ accountId: { $eq: 'acc-1' } })
      .fetchPage({ $orderBy: { engagementId: 'asc' } });

    expect(afterEngagements.data.map((row) => [row['engagementId'], row['status']])).toEqual([
      ['eng-1', 'cancelled: Churned'],
      ['eng-2', 'won'],
    ]);

    const history = await ObjectTypesV2.getEditsHistory(client, ONTOLOGY_RID, ACCOUNT, {
      objectPrimaryKey: { accountId: { type: 'stringValue', value: 'acc-1' } },
      sortOrder: 'oldest_first',
    });

    expect(history.data.map((entry) => entry.edit.type)).toEqual(['createEdit', 'modifyEdit']);
  });
});

describe('stock @osdk/client end-to-end Object security policies against Postgres', () => {
  let live: LiveServer;
  let clients: Record<'ann' | 'ben' | 'admin', Client>;

  beforeAll(async () => {
    const ir = jobsiteIr();
    const grants = jobsiteGrants(ir);

    live = await startLiveServer({ tag: 'policy', ir, grants, users: jobsiteUsers(grants) });

    await seedJobsite(live.db);

    const exp = now() + 3600;

    const makeClient = async (person: Person) => {
      const token = await live.issuer.workos({ exp, ...PEOPLE[person] });

      return createClient(live.baseUrl, ONTOLOGY_RID, () => Promise.resolve(token));
    };

    clients = { ann: await makeClient('ann'), ben: await makeClient('ben'), admin: await makeClient('admin') };
  }, 60_000);

  afterAll(async () => {
    await live?.stop();
  });

  it('enforces Object and Property security policies across fetchPage and pivotTo for each caller', async () => {
    const readJobsites = async (person: keyof typeof clients) => {
      const page = await objectSet(clients[person], JOBSITE).fetchPage({ $orderBy: { jobsiteId: 'asc' } });

      return page.data.map((row) => [row['jobsiteId'], row['budget']]);
    };

    expect(await readJobsites('ann')).toEqual([
      ['j-1', undefined],
      ['j-2', undefined],
    ]);

    expect(await readJobsites('ben')).toEqual([
      ['j-2', undefined],
      ['j-3', undefined],
    ]);

    expect(await readJobsites('admin')).toEqual([
      ['j-1', 120000],
      ['j-2', 80000],
      ['j-3', 50000],
    ]);

    const readLogs = async (person: keyof typeof clients) => {
      const page = await objectSet(clients[person], CREW)
        .pivotTo('jobsites')
        .pivotTo('dailyLogs')
        .fetchPage({ $orderBy: { logId: 'asc' } });

      return page.data.map((row) => row['logId']);
    };

    expect(await readLogs('ann')).toEqual(['log-1', 'log-2']);

    expect(await readLogs('ben')).toEqual(['log-2', 'log-3', 'log-4']);

    expect(await readLogs('admin')).toEqual(['log-1', 'log-2', 'log-3', 'log-4']);
  });
});
